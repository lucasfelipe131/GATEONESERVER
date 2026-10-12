import { createBusinessEvent } from '../core/events.js';
import { appendOutboxEvent } from '../core/outbox.js';
import { expirationForPlan } from '../core/renewal-orchestrator.js';
import { dateOnlyInTimezone } from '../domain/billing.js';
import { automaticRenewalDecision } from './automatic-renewal-policy.js';

const fail=code=>Object.assign(new Error(code),{code});
export function expectedRenewalExpiration(previous,months,{now=new Date(),timezone='America/Sao_Paulo'}={}) {
  const today=dateOnlyInTimezone(now,timezone);
  return expirationForPlan(previous>today?previous:today,{durationMonths:months});
}
const executionRows = `SELECT r.*,ch.amount_cents,ch.amount_cents AS charge_amount_cents,
  ch.stage AS charge_stage,ch.status AS charge_status,s.customer_id,s.id AS subscription_id,
  s.expires_on::text AS current_expiry,s.bitpanel_list_id,c.name AS customer_name,c.whatsapp_e164,
  c.bitpanel_reference,c.bitpanel_owner,c.automation_eligible,
  p.code AS plan_code,p.name AS plan_name,p.duration_months,p.price_cents AS plan_price_cents,
  pay.id AS verified_payment_id,pay.charge_id AS payment_charge_id,pay.status AS payment_status,
  pay.amount_cents AS paid_amount,pay.customer_id AS payer_customer,pay.subscription_id AS payer_subscription,
  pay.provider AS payment_provider,pay.currency AS payment_currency,pay.external_payment_id,
  pay.confirmed_at,pay.reconciliation_status,pay.review_reason,pay.provider_payload
  FROM renewal_jobs r JOIN charges ch ON ch.id=r.charge_id JOIN subscriptions s ON s.id=ch.subscription_id
  JOIN customers c ON c.id=s.customer_id JOIN plans p ON p.id=COALESCE(ch.plan_id,s.plan_id)
  LEFT JOIN payments pay ON pay.id=r.payment_id`;

async function lockedPolicy(client) {
  return (await client.query("SELECT value FROM system_settings WHERE key='automatic_renewal_policy' FOR SHARE")).rows[0]?.value;
}

async function lockedRuntime(client,{allowAutomatic=true}={}) {
  const rows=(await client.query("SELECT key,value FROM system_settings WHERE key IN ('global_pause','payment_mode','bitpanel_mode') FOR SHARE")).rows;
  const values=Object.fromEntries(rows.map(row=>[row.key,row.value]));
  return {paused:values.global_pause===true,automaticLive:allowAutomatic &&
    (values.payment_mode===undefined||values.payment_mode==='live') && (values.bitpanel_mode===undefined||values.bitpanel_mode==='live')};
}

function automaticFor(policy,row,now) {
  return automaticRenewalDecision({policy,renewal:row,now,
    payment:{id:row.verified_payment_id,charge_id:row.payment_charge_id,customer_id:row.payer_customer,
      subscription_id:row.payer_subscription,provider:row.payment_provider,status:row.payment_status,
      amount_cents:row.paid_amount,currency:row.payment_currency,external_payment_id:row.external_payment_id,
      confirmed_at:row.confirmed_at,reconciliation_status:row.reconciliation_status,review_reason:row.review_reason,
      provider_payload:row.provider_payload},
    customer:{id:row.customer_id,subscription_id:row.subscription_id,bitpanel_list_id:row.bitpanel_list_id,
      bitpanel_reference:row.bitpanel_reference,bitpanel_owner:row.bitpanel_owner,automation_eligible:row.automation_eligible}});
}

function policySnapshot(policy) {
  const plans={};
  for(const code of ['monthly','quarterly','semiannual','annual']) {
    const plan=policy.plans?.[code];
    if(plan) plans[code]={durationMonths:plan.durationMonths,priceCents:plan.priceCents,creditCost:plan.creditCost};
  }
  return {enabled:policy.enabled,activatedAt:policy.activatedAt,validatedAt:policy.validatedAt,
    ...(policy.validUntil!==undefined?{validUntil:policy.validUntil}:{}),provider:policy.provider,operation:policy.operation,
    planLabel:policy.planLabel,maxConnections:policy.maxConnections,unitPriceCents:policy.unitPriceCents,
    maxCreditsPerRenewal:policy.maxCreditsPerRenewal,plans};
}

export async function claimRenewalExecution(db,{renewalId,correlationId,requiresApproval=true,allowAutomatic=true,now=new Date()}) {
  return db.transaction(async client=>{
    const policy=await lockedPolicy(client);
    const runtime=await lockedRuntime(client,{allowAutomatic});
    if(runtime.paused) throw fail('AUTOMATIONS_PAUSED');
    const row=(await client.query(`${executionRows} WHERE r.id=$1 FOR UPDATE OF r,ch,s,c,p`,[renewalId])).rows[0];
    if(!row) throw fail('RENEWAL_NOT_FOUND');
    if(row.core_status==='COMPLETED'||row.status==='completed') return {claimed:false,duplicate:true};
    if(row.core_status==='PROCESSING'||row.core_status==='VERIFYING'||row.status==='running') throw fail('RENEWAL_RESULT_REQUIRES_REVIEW');
    if(row.attempts>0 || ['FAILED','HUMAN_ACTION_REQUIRED'].includes(row.core_status)) throw fail('RENEWAL_RESULT_REQUIRES_REVIEW');
    // An outer join cannot lock a missing payment. Lock the existing row before
    // authorization so a refund/update cannot race the execution claim.
    const lockedPayment=row.payment_id?(await client.query('SELECT * FROM payments WHERE id=$1 FOR UPDATE',[row.payment_id])).rows[0]:null;
    Object.assign(row,{verified_payment_id:lockedPayment?.id,payment_charge_id:lockedPayment?.charge_id,
      payment_status:lockedPayment?.status,paid_amount:lockedPayment?.amount_cents,payer_customer:lockedPayment?.customer_id,
      payer_subscription:lockedPayment?.subscription_id,payment_provider:lockedPayment?.provider,payment_currency:lockedPayment?.currency,
      external_payment_id:lockedPayment?.external_payment_id,confirmed_at:lockedPayment?.confirmed_at,
      reconciliation_status:lockedPayment?.reconciliation_status,review_reason:lockedPayment?.review_reason,provider_payload:lockedPayment?.provider_payload});
    if(row.charge_status!=='paid'||row.payment_status!=='CONFIRMED'||row.amount_cents!==row.paid_amount||
        row.customer_id!==row.payer_customer||row.subscription_id!==row.payer_subscription||row.charge_id!==row.payment_charge_id) throw fail('VERIFIED_PAYMENT_REQUIRED');
    if(!['awaiting_approval','queued'].includes(row.status)||!['READY',null].includes(row.core_status)) throw fail('RENEWAL_RESULT_REQUIRES_REVIEW');
    const decision=automaticFor(policy,row,now);
    const automatic=!row.approved_at&&runtime.automaticLive&&decision.allowed;
    if(requiresApproval&&!row.approved_at&&!automatic) throw fail('RENEWAL_APPROVAL_REQUIRED');
    // Global approval remains enabled; an automatic exception has its own audit
    // context and never forges a human approved_at timestamp.
    if(!row.approved_at&&!automatic) throw fail('RENEWAL_APPROVAL_REQUIRED');
    await client.query(`UPDATE renewal_jobs SET status='running',core_status='PROCESSING',correlation_id=$2,
      attempts=attempts+1,updated_at=now() WHERE id=$1`,[renewalId,correlationId]);
    await appendOutboxEvent(client,createBusinessEvent({eventType:'renewal.processing',correlationId,
      actor:{type:'WORKER',id:'gate-one-renewals'},subject:{type:'renewal',id:renewalId},payload:{customer_id:row.customer_id,
        payment_id:row.payment_id,automatic_renewal:automatic,...(automatic?{credit_cost:decision.creditCost}:{})}}));
    return {claimed:true,automatic,creditCost:automatic?decision.creditCost:null,
      policy:automatic?policySnapshot(policy):null,renewal:row};
  });
}

// Recovery only marks newly paid, eligible renewals as queued. The claim above
// reads policy and ledger again; queue messages cannot grant authorization.
export async function recoverPolicyRenewals(db,{limit=100,now=new Date()}={}) {
  const boundedLimit=Math.max(1,Math.min(Number.isSafeInteger(limit)?limit:100,100));
  return db.transaction(async client=>{
    const policy=await lockedPolicy(client);
    const runtime=await lockedRuntime(client);
    if(policy?.enabled!==true||runtime.paused||!runtime.automaticLive) return {renewalIds:[],skipped:true};
    const rows=(await client.query(`${executionRows}
      WHERE r.status='awaiting_approval' AND r.approved_at IS NULL AND r.attempts=0 AND r.core_status='READY'
      AND ch.status='paid' ORDER BY r.created_at LIMIT $1 FOR UPDATE OF r SKIP LOCKED`,[boundedLimit])).rows;
    const renewalIds=[];
    for(const row of rows) {
      if(!automaticFor(policy,row,now).allowed) continue;
      const updated=await client.query(`UPDATE renewal_jobs SET status='queued',error=NULL,updated_at=now()
        WHERE id=$1 AND status='awaiting_approval' AND approved_at IS NULL AND attempts=0 AND core_status='READY' RETURNING id`,[row.id]);
      if(updated.rows[0]) renewalIds.push(updated.rows[0].id);
    }
    return {renewalIds,skipped:false};
  });
}

export async function invalidateCustomerAccessProvenance(client,customerId) {
  await client.query(`UPDATE customer_access_sync SET status='STALE',verified_at=NULL,attempted_at=now()-interval '16 minutes',
    last_error_code='BITPANEL_ACCESS_REFRESH_REQUIRED',updated_at=now() WHERE customer_id=$1`,[customerId]);
}
