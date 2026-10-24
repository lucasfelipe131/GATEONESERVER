import { createBusinessEvent } from '../core/events.js';
import { appendOutboxEvent } from '../core/outbox.js';
import { expirationForPlan } from '../core/renewal-orchestrator.js';
import { dateOnlyInTimezone } from '../domain/billing.js';
import { automaticRenewalDecision } from './automatic-renewal-policy.js';

const fail=code=>Object.assign(new Error(code),{code});
const uuid=value=>typeof value==='string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
const gateOneOwner=value=>typeof value==='string' && ['gateoneproserver','gateoneserver'].includes(
  value.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,''));
const bindingErrors=new Set(['RENEWAL_BINDING_INVALID','RENEWAL_BINDING_CHANGED','RENEWAL_BINDING_CONFLICT']);
const bindingFor=row=>({customerId:row.customer_id,subscriptionId:row.subscription_id,listId:row.bitpanel_list_id,
  username:row.bitpanel_reference,owner:row.bitpanel_owner});

// A historical or inactive customer still owns a sensitive reference until it
// is explicitly unlinked. Approval cannot override ambiguous local ownership.
export async function assertRenewalBindingUnique(client,{customerId,subscriptionId,listId,username,owner}={}) {
  if(!uuid(customerId)||!uuid(subscriptionId)||typeof listId!=='string'||!/^[1-9]\d{0,19}$/.test(listId)||
    typeof username!=='string'||!username.trim()||username.trim()!==username||username.length>120||/[\r\n\x00]/.test(username)||
    !gateOneOwner(owner))throw fail('RENEWAL_BINDING_INVALID');
  const row=(await client.query(`SELECT c.bitpanel_reference,c.bitpanel_owner,s.bitpanel_list_id
    FROM customers c JOIN subscriptions s ON s.customer_id=c.id
    WHERE c.id=$1 AND s.id=$2 FOR UPDATE OF c,s`,[customerId,subscriptionId])).rows[0];
  if(!row||row.bitpanel_reference!==username||row.bitpanel_list_id!==listId||
    row.bitpanel_owner!==owner||!gateOneOwner(row.bitpanel_owner))throw fail('RENEWAL_BINDING_CHANGED');
  const conflict=(await client.query(`SELECT EXISTS(
    SELECT 1 FROM customers c WHERE c.id<>$1 AND lower(trim(c.bitpanel_reference))=lower(trim($2))
    UNION ALL SELECT 1 FROM subscriptions s WHERE s.customer_id<>$1
      AND trim(s.bitpanel_list_id) ~ '^[0-9]{1,20}$' AND ltrim(trim(s.bitpanel_list_id),'0')=$3
    ) AS conflict`,[customerId,username,listId])).rows[0]?.conflict;
  if(conflict!==false)throw fail('RENEWAL_BINDING_CONFLICT');
  return{verified:true};
}
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

async function automaticFor(client,policy,row,now) {
  const decision=automaticRenewalDecision({policy,renewal:row,now,
    payment:{id:row.verified_payment_id,charge_id:row.payment_charge_id,customer_id:row.payer_customer,
      subscription_id:row.payer_subscription,provider:row.payment_provider,status:row.payment_status,
      amount_cents:row.paid_amount,currency:row.payment_currency,external_payment_id:row.external_payment_id,
      confirmed_at:row.confirmed_at,reconciliation_status:row.reconciliation_status,review_reason:row.review_reason,
      provider_payload:row.provider_payload},
    customer:{id:row.customer_id,subscription_id:row.subscription_id,bitpanel_list_id:row.bitpanel_list_id,
      bitpanel_reference:row.bitpanel_reference,bitpanel_owner:row.bitpanel_owner,automation_eligible:row.automation_eligible}});
  if(decision.allowed)try{await assertRenewalBindingUnique(client,bindingFor(row));}catch(error){
    if(!bindingErrors.has(error?.code))throw error;
    return{allowed:false,requiresApproval:true,code:error.code,creditCost:null};
  }
  return decision;
}

async function reloadVerifiedPayment(client,row) {
  const payment=row.payment_id?(await client.query('SELECT * FROM payments WHERE id=$1 FOR UPDATE',[row.payment_id])).rows[0]:null;
  Object.assign(row,{verified_payment_id:payment?.id,payment_charge_id:payment?.charge_id,
    payment_status:payment?.status,paid_amount:payment?.amount_cents,payer_customer:payment?.customer_id,
    payer_subscription:payment?.subscription_id,payment_provider:payment?.provider,payment_currency:payment?.currency,
    external_payment_id:payment?.external_payment_id,confirmed_at:payment?.confirmed_at,
    reconciliation_status:payment?.reconciliation_status,review_reason:payment?.review_reason,provider_payload:payment?.provider_payload});
  if(row.charge_status!=='paid'||row.payment_status!=='CONFIRMED'||row.amount_cents!==row.paid_amount||
    row.customer_id!==row.payer_customer||row.subscription_id!==row.payer_subscription||row.charge_id!==row.payment_charge_id)
    throw fail('VERIFIED_PAYMENT_REQUIRED');
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
    await reloadVerifiedPayment(client,row);
    if(!['awaiting_approval','queued'].includes(row.status)||!['READY',null].includes(row.core_status)) throw fail('RENEWAL_RESULT_REQUIRES_REVIEW');
    const decision=await automaticFor(client,policy,row,now);
    if(bindingErrors.has(decision.code))throw fail(decision.code);
    const automatic=!row.approved_at&&runtime.automaticLive&&decision.allowed;
    if(requiresApproval&&!row.approved_at&&!automatic) throw fail('RENEWAL_APPROVAL_REQUIRED');
    // Global approval remains enabled; an automatic exception has its own audit
    // context and never forges a human approved_at timestamp.
    if(!row.approved_at&&!automatic) throw fail('RENEWAL_APPROVAL_REQUIRED');
    if(row.charge_stage!=='new_sale'&&row.bitpanel_list_id)await assertRenewalBindingUnique(client,bindingFor(row));
    await client.query(`UPDATE renewal_jobs SET status='running',core_status='PROCESSING',correlation_id=$2,
      attempts=attempts+1,updated_at=now() WHERE id=$1`,[renewalId,correlationId]);
    await appendOutboxEvent(client,createBusinessEvent({eventType:'renewal.processing',correlationId,
      actor:{type:'WORKER',id:'gate-one-renewals'},subject:{type:'renewal',id:renewalId},payload:{customer_id:row.customer_id,
        payment_id:row.payment_id,automatic_renewal:automatic,...(automatic?{credit_cost:decision.creditCost}:{})}}));
    return {claimed:true,automatic,creditCost:automatic?decision.creditCost:null,
      policy:automatic?policySnapshot(policy):null,renewal:row};
  });
}

// Recheck immediately before the external submit, then once more inside the
// completion transaction. No database lock is held while a browser is running.
export async function verifyRenewalExecutionBinding(db,input,{client=null,now=new Date()}={}) {
  if(!uuid(input?.renewalId)||!uuid(input?.correlationId))throw fail('RENEWAL_BINDING_INVALID');
  const verify=async connection=>{
    const policy=await lockedPolicy(connection),runtime=await lockedRuntime(connection);
    if(runtime.paused)throw fail('AUTOMATIONS_PAUSED');
    const row=(await connection.query(`${executionRows} WHERE r.id=$1 FOR UPDATE OF r,ch,s,c,p`,[input.renewalId])).rows[0];
    if(!row||row.status!=='running'||row.core_status!=='PROCESSING'||row.attempts!==1||row.completed_at||row.after_expiry||
      row.correlation_id!==input.correlationId)throw fail('RENEWAL_RESULT_REQUIRES_REVIEW');
    if(row.customer_id!==input.customerId||row.subscription_id!==input.subscriptionId||
      row.bitpanel_list_id!==input.listId||row.bitpanel_reference!==input.username||row.bitpanel_owner!==input.owner||
      input.currentExpiry!==undefined&&row.current_expiry!==input.currentExpiry)throw fail('RENEWAL_BINDING_CHANGED');
    await reloadVerifiedPayment(connection,row);
    await assertRenewalBindingUnique(connection,input);
    if(!row.approved_at){
      const decision=await automaticFor(connection,policy,{...row,status:'queued',core_status:'READY',attempts:0,processing_at:null},now);
      if(bindingErrors.has(decision.code))throw fail(decision.code);
      if(!runtime.automaticLive||!decision.allowed)throw fail('RENEWAL_APPROVAL_REQUIRED');
    }
    return{verified:true};
  };
  return client?verify(client):db.transaction(verify);
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
      if(!(await automaticFor(client,policy,row,now)).allowed) continue;
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
