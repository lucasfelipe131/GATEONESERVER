import { createBusinessEvent } from '../core/events.js';
import { appendOutboxEvent } from '../core/outbox.js';
import { expirationForPlan } from '../core/renewal-orchestrator.js';
import { dateOnlyInTimezone } from '../domain/billing.js';

const fail=code=>Object.assign(new Error(code),{code});
export function expectedRenewalExpiration(previous,months,{now=new Date(),timezone='America/Sao_Paulo'}={}) {
  const today=dateOnlyInTimezone(now,timezone);
  return expirationForPlan(previous>today?previous:today,{durationMonths:months});
}
export async function claimRenewalExecution(db,{renewalId,correlationId,requiresApproval=true}) {
  return db.transaction(async client=>{
    const row=(await client.query(`SELECT r.*,ch.amount_cents,ch.status AS charge_status,s.customer_id,s.id AS subscription_id,
      pay.status AS payment_status,pay.amount_cents AS paid_amount,pay.customer_id AS payer_customer,pay.subscription_id AS payer_subscription
      FROM renewal_jobs r JOIN charges ch ON ch.id=r.charge_id JOIN subscriptions s ON s.id=ch.subscription_id
      LEFT JOIN payments pay ON pay.id=r.payment_id WHERE r.id=$1 FOR UPDATE OF r`,[renewalId])).rows[0];
    if(!row) throw fail('RENEWAL_NOT_FOUND');
    if(row.core_status==='COMPLETED'||row.status==='completed') return {claimed:false,duplicate:true};
    if(row.core_status==='PROCESSING'||row.core_status==='VERIFYING'||row.status==='running') throw fail('RENEWAL_RESULT_REQUIRES_REVIEW');
    if(row.attempts>0 || ['FAILED','HUMAN_ACTION_REQUIRED'].includes(row.core_status)) throw fail('RENEWAL_RESULT_REQUIRES_REVIEW');
    if(row.charge_status!=='paid'||row.payment_status!=='CONFIRMED'||row.amount_cents!==row.paid_amount||
        row.customer_id!==row.payer_customer||row.subscription_id!==row.payer_subscription) throw fail('VERIFIED_PAYMENT_REQUIRED');
    if(requiresApproval&&!row.approved_at) throw fail('RENEWAL_APPROVAL_REQUIRED');
    await client.query(`UPDATE renewal_jobs SET status='running',core_status='PROCESSING',correlation_id=$2,
      attempts=attempts+1,updated_at=now() WHERE id=$1`,[renewalId,correlationId]);
    await appendOutboxEvent(client,createBusinessEvent({eventType:'renewal.processing',correlationId,
      actor:{type:'WORKER',id:'gate-one-renewals'},subject:{type:'renewal',id:renewalId},payload:{customer_id:row.customer_id,payment_id:row.payment_id}}));
    return {claimed:true};
  });
}
