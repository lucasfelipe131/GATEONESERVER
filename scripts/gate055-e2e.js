// Explicit staging test runner. No server routes, real providers, or transports.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDb } from '../src/db.js';
import { scanBilling } from '../src/services/billing.js';
import { PaymentWatcher } from '../src/services/payment-watcher.js';
import { GateConversationAgent } from '../src/services/conversation-agent.js';
import { ConversationToolRegistry } from '../src/services/conversation-tools.js';
import { PgConversationAgentRepository } from '../src/services/conversation-operations.js';
import { createCustomerContextSnapshot } from '../src/services/customer-context.js';
import { resolveIdentity, getCustomerContext, paymentOperationStatus, renewalOperationStatus } from '../src/services/gate-core.js';

const env=process.env;
assert.equal(env.GATE_ENVIRONMENT,'staging-055'); assert.equal(env.GATE_TEST_MODE,'true');
assert.equal(env.PROVIDER_MODE,'fake-only'); assert.equal(env.PAYMENT_MODE,'simulation');
assert.equal(env.WHATSAPP_MODE,'simulation'); assert.equal(env.BITPANEL_MODE,'disabled');
assert.ok(['normal','crash','verify'].includes(env.GATE_055_E2E_MODE));
const correlation=env.GATE_055_E2E_CORRELATION_ID; assert.match(correlation||'',/^[0-9a-f-]{36}$/);
const db=createDb(env.DATABASE_URL,{ssl:env.DATABASE_SSL==='true'});
const log=(marker,data={})=>console.log(JSON.stringify({marker,correlation_id:correlation,...data}));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
try {
 let existing=await db.query('SELECT id FROM customers WHERE source=$1',[`gate055-e2e:${correlation}`]);
 let customer=existing.rows[0]?.id;
 if(!customer){
  customer=randomUUID(); const subscription=randomUUID();
  await db.transaction(async c=>{
   const plan=(await c.query("SELECT id FROM plans WHERE active=true AND duration_months=1 LIMIT 1")).rows[0]; assert.ok(plan);
   await c.query(`INSERT INTO customers(id,name,source,status,lifecycle_status,automation_eligible,consent_contact)
    VALUES($1,'GATE055 E2E SYNTHETIC',$2,'active','ACTIVE',true,true)`,[customer,`gate055-e2e:${correlation}`]);
   await c.query(`INSERT INTO customer_identities(customer_id,identity_type,provider,external_id,normalized_value,verified_at)
    VALUES($1,'LOGIN','core',$2,$2,now())`,[customer,`synthetic-${correlation}`]);
   await c.query(`INSERT INTO subscriptions(id,customer_id,plan_id,expires_on,provider,provider_reference)
    VALUES($1,$2,$3,CURRENT_DATE,'fake',$4)`,[subscription,customer,plan.id,`synthetic-${correlation}`]);
  });
 }
 const statusInput=i=>({customerId:i.customer_id,subscriptionId:i.subscription_id||null});
 const repo=new PgConversationAgentRepository(db);
 const registry=new ConversationToolRegistry({handlers:{
  resolveCustomer:i=>resolveIdentity(db,i),
  getCustomerContext:i=>createCustomerContextSnapshot(db,{customerId:i.customer_id,purpose:i.purpose,channel:'WHATSAPP',requestedScopes:i.requested_scopes,correlationId:i.correlation_id}),
  getSubscription:async i=>{const c=await getCustomerContext(db,i.customer_id);return {...c,status:c.subscription_status};},
  getPaymentStatus:i=>paymentOperationStatus(db,statusInput(i)),
  getRenewalStatus:i=>renewalOperationStatus(db,statusInput(i)),
  requestRenewal:i=>renewalOperationStatus(db,statusInput(i)),
  // Fake payment creation adapter: real Billing creates the charge, then this
  // fixture adapter records the simulated provider's initial pending operation.
  createPaymentRequest:async i=>{
   assert.equal(i.customer_id,customer);
   const scoped={...db,query:async(sql,params)=>{
    const r=await db.query(sql,params);
    return sql.includes('FROM subscriptions s') ? {...r,rows:r.rows.filter(x=>x.customer_id===customer),rowCount:r.rows.filter(x=>x.customer_id===customer).length}:r;
   }};
   await scanBilling(scoped,{timezone:'UTC'});
   return db.transaction(async c=>{
    const charge=(await c.query(`SELECT ch.*,s.customer_id,p.duration_months FROM charges ch JOIN subscriptions s ON s.id=ch.subscription_id
      JOIN plans p ON p.id=s.plan_id WHERE s.customer_id=$1 ORDER BY ch.created_at DESC LIMIT 1`,[customer])).rows[0]; assert.ok(charge);
    const payment=randomUUID();
    const result=await c.query(`INSERT INTO payments(id,customer_id,subscription_id,charge_id,provider,external_payment_id,amount_cents,status,idempotency_key,correlation_id)
      VALUES($1,$2,$3,$4,'fake',$5,$6,'PENDING',$5,$7) ON CONFLICT(idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key RETURNING *`,
      [payment,customer,charge.subscription_id,charge.id,`fake-${correlation}`,charge.amount_cents,correlation]);
    await c.query(`INSERT INTO renewal_jobs(charge_id,payment_id,core_status,previous_expiration,requested_extension_months,idempotency_key,correlation_id)
      VALUES($1,$2,'WAITING_PAYMENT',CURRENT_DATE,$3,$4,$5) ON CONFLICT(charge_id) DO NOTHING`,[charge.id,result.rows[0].id,charge.duration_months,`fake-renew-${correlation}`,correlation]);
    return {customer_id:customer,charge_id:charge.id,status:'PENDING',amount_cents:charge.amount_cents,currency:'BRL',existing:false};
   });
  },
  requestHumanHandoff:i=>repo.requestHandoff(i)
 }});
 const agent=new GateConversationAgent({repository:repo,registry});
 const turn=(messageId,text)=>agent.process({conversationId:`fake-whatsapp-${correlation}`,messageId,text,
  identity:{type:'LOGIN',value:`synthetic-${correlation}`,provider:'core'},correlationId:correlation});
 if(!existing.rows.length){
  const first=await turn('renew','quero renovar');
  log('FIRST_TURN',{intent:first.intent,outcome:first.outcome,facts:first.response_facts});
  assert.equal(first.intent,'RENEWAL_REQUEST'); assert.equal(first.response_facts.payment_status,'PENDING');
  await turn('renew-duplicate','quero renovar');
  const pending=await turn('claim-paid','paguei'); assert.equal(pending.response_facts.payment_status,'PENDING');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM provisioning_operations WHERE customer_id=$1',[customer])).rows[0].n,0);
  log('PENDING_PAGUEI_NO_PROVISIONING_PASS');
  const p=(await db.query('SELECT * FROM payments WHERE customer_id=$1',[customer])).rows[0];
  const watcher=new PaymentWatcher({db,providerName:'fake'});
  const fake={externalPaymentId:p.external_payment_id,externalEventId:`confirmed-${correlation}`,status:'CONFIRMED',amountCents:p.amount_cents,currency:'BRL'};
  await watcher.observe(fake,{source:'POLLING',providerVerified:true,correlationId:correlation});
  assert.equal((await watcher.observe(fake,{source:'POLLING',providerVerified:true,correlationId:correlation})).duplicate,true);
  log('FAKE_PROVIDER_CONFIRMED');
 }
 if(env.GATE_055_E2E_MODE==='crash'){log('CRASH_SCENARIO_SUBMITTED');}
 else {
  let rows;
  for(let n=0;n<45;n++){
   rows=(await db.query(`SELECT rs.state,rs.target_expiration::text,rs.previous_expiration::text,s.expires_on::text
     FROM renewal_sagas rs JOIN subscriptions s ON s.id=rs.subscription_id WHERE rs.customer_id=$1`,[customer])).rows;
   const backlog=(await db.query(`SELECT count(*)::int n FROM gate_event_outbox WHERE correlation_id=$1 AND publish_status<>'PUBLISHED'`,[correlation])).rows[0].n;
   if(rows[0]?.state==='COMPLETED' && backlog===0)break;
   await sleep(1000);
  }
  assert.equal(rows[0]?.state,'COMPLETED');assert.equal(rows[0].expires_on,rows[0].target_expiration);
  assert.notEqual(rows[0].expires_on,rows[0].previous_expiration);
  const counts=(await db.query(`SELECT
   (SELECT count(*)::int FROM payments WHERE customer_id=$1) payments,
   (SELECT count(*)::int FROM renewal_sagas WHERE customer_id=$1) renewals,
   (SELECT count(*)::int FROM provisioning_operations WHERE customer_id=$1) provisioning,
   (SELECT count(*)::int FROM operational_transition_audit WHERE correlation_id=$2 AND after_state->>'state'='PROCESSING') processing,
   (SELECT count(*)::int FROM notification_requests WHERE customer_id=$1 AND intention='RENEWAL_COMPLETED' AND status='SENT') notifications`,[customer,correlation])).rows[0];
  assert.deepEqual(counts,{payments:1,renewals:1,provisioning:1,processing:1,notifications:1});
  const final=await turn(`status-${env.GATE_055_E2E_MODE}`,'já renovou?');
  assert.equal(final.response_facts.renewal_status,'COMPLETED');
  const context=await getCustomerContext(db,customer); assert.equal(context.expires_at.slice(0,10),rows[0].target_expiration);
  log('GATE_055_E2E_PASS',{counts,expiration:rows[0].target_expiration,facts:final.response_facts});
 }
} catch(error){log('GATE_055_E2E_FAIL',{error:error.message,code:error.code});process.exitCode=1;}
finally{await db.close();}
