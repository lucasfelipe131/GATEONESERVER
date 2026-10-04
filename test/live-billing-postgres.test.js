import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { migrateDatabase } from '../src/migrations.js';
import { LiveBillingAutomation, liveBillingContext,createBillingAutomation } from '../src/services/live-billing.js';
import { reconcileMercadoPagoPayment,moneyInCents } from '../src/services/mercadopago-reconciliation.js';
import { deliverCoreNotification,liveEventHandlers } from '../src/services/live-outbox.js';
import { OutboxDispatcher } from '../src/core/outbox.js';
import { claimRenewalExecution } from '../src/services/renewal-execution.js';
import { PgConversationAgentRepository } from '../src/services/conversation-operations.js';

function adapter(pg) {
  const client=pg=>({query:async(sql,params)=>{
    const r=!params&&/;\s*\S/.test(sql.trim().replace(/;$/,''))?(await pg.exec(sql)).at(-1):await pg.query(sql,params);
    return {...r,rowCount:r.rowCount??r.affectedRows??r.rows.length};
  }});
  return {...client(pg),transaction:fn=>pg.transaction(tx=>fn(client(tx)))};
}

test('live billing flow uses only synthetic providers and preserves durable financial and delivery boundaries',async t=>{
  const pg=new PGlite({extensions:{pgcrypto}}),db=adapter(pg);
  const customer=randomUUID(),subscription=randomUUID(),plan=randomUUID();
  let creates=0,providerResult;
  const billing=new LiveBillingAutomation({db,assertEnabled:async()=>{},
    createCheckout:async charge=>{creates++;providerResult={id:'synthetic-preference',checkoutUrl:`https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=${charge.id}`,simulated:false};return providerResult;},
    recoverCheckout:async()=>providerResult});
  try {
    await migrateDatabase(db);
    await db.query("INSERT INTO plans(id,code,name,duration_months,price_cents) VALUES($1,'monthly','Mensal',1,3000)",[plan]);
    await db.query("INSERT INTO customers(id,name,whatsapp_e164,status,consent_contact,automation_eligible) VALUES($1,'Sintético','5511999999999','active',true,true)",[customer]);
    await db.query("INSERT INTO subscriptions(id,customer_id,plan_id,status,expires_on) VALUES($1,$2,$3,'active','2026-10-06')",[subscription,customer,plan]);
    await db.query("INSERT INTO system_settings(key,value) VALUES('sales_mode','\"automatic\"'::jsonb)");
    let checkout;
    await t.test('a committed pending ledger is created before one checkout, repeated requests reuse it',async()=>{
      checkout=await billing.requestPayment({customer_id:customer});
      assert.equal(checkout.id,checkout.charge_id);assert.equal(checkout.plan_code,'monthly');assert.equal(checkout.plan_name,'Mensal');
      assert.equal(checkout.simulated,false);assert.equal(creates,1);
      const again=await billing.requestPayment({customer_id:customer});assert.equal(again.checkout_url,checkout.checkout_url);assert.equal(creates,1);
      const payment=(await db.query('SELECT * FROM payments')).rows[0];assert.equal(payment.external_payment_id,null);assert.equal(payment.status,'PENDING');
      assert.equal((await db.query('SELECT count(*)::int AS n FROM charges')).rows[0].n,1);
    });
    await t.test('all reminder stages share that charge; duplicate scans do not duplicate deliveries',async()=>{
      for(const date of ['2026-10-03','2026-10-06','2026-10-08','2026-10-11']) {
        const options={now:new Date(date+'T12:00:00Z')};
        assert.equal((await billing.scanReminders(options)).notifications,1);
        assert.equal((await billing.scanReminders(options)).notifications,0);
      }
      assert.equal(creates,1);assert.equal((await db.query('SELECT count(*)::int AS n FROM notification_requests')).rows[0].n,4);
    });
    const approved={id:123456,status:'approved',live_mode:true,currency_id:'BRL',transaction_amount:30,
      external_reference:checkout.charge_id,collector_id:98765};
    await t.test('an approved legacy reminder enters the same durable delivery pipeline once',async()=>{
      const first=await billing.requestChargeNotice({chargeId:checkout.charge_id});assert.equal(first.queued,true);
      assert.equal((await billing.requestChargeNotice({chargeId:checkout.charge_id})).queued,false);
      assert.equal(creates,1);
    });
    const reconcile=p=>reconcileMercadoPagoPayment({db,config:{PAYMENT_MODE:'live'},paymentId:'123456',getPayment:async()=>p,getAccount:async()=>({id:'98765'})});
    await t.test('amount, currency, merchant, test payments and provider ID mismatches cannot confirm',async()=>{
      for(const patch of [{transaction_amount:29.99},{transaction_amount:30.001},{currency_id:'USD'},
        {collector_id:123},{live_mode:false},{id:123457}]) await assert.rejects(reconcile({...approved,...patch}));
      assert.equal((await db.query('SELECT status FROM payments')).rows[0].status,'PENDING');
      assert.equal((await db.query("SELECT count(*)::int AS n FROM gate_event_outbox WHERE event_type='payment.confirmed'")).rows[0].n,0);
    });
    await t.test('an authenticated matching payment confirms the existing pending row once',async()=>{
      const first=await reconcile(approved);assert.equal(first.confirmed,true);assert.equal(first.duplicate,false);
      const duplicate=await reconcile(approved);assert.equal(duplicate.duplicate,true);
      assert.equal((await db.query('SELECT count(*)::int AS n FROM payments')).rows[0].n,1);
      assert.equal((await db.query('SELECT status FROM charges')).rows[0].status,'paid');
      assert.equal((await db.query("SELECT count(*)::int AS n FROM gate_event_outbox WHERE event_type='payment.confirmed'")).rows[0].n,1);
    });
    await t.test('outbox replay enqueues durable notification IDs and cancels reminders paid meanwhile',async()=>{
      const jobs=new Map();
      const queues={messages:{add:async(name,data,options)=>jobs.set(options.jobId,{name,data})}};
      const dispatcher=new OutboxDispatcher({db,workerId:'synthetic-worker',handlers:liveEventHandlers({queues}),env:{}});
      const first=await dispatcher.dispatchBatch();const second=await dispatcher.dispatchBatch();
      assert.equal(first.failed+second.failed,0,JSON.stringify((await db.query("SELECT event_type,last_error FROM gate_event_outbox WHERE publish_status='FAILED'")).rows));
      assert.equal(jobs.size,6);
      let sends=0;
      for(const job of jobs.values()) await deliverCoreNotification({db,config:{},notificationId:job.data.notificationId,
        send:async()=>{sends++;return {ok:true,providerId:'synthetic-delivery'};}});
      assert.equal(sends,1);
      const paidNotice=(await db.query("SELECT id FROM notification_requests WHERE intention='PAYMENT_CONFIRMED'")).rows[0];
      await deliverCoreNotification({db,config:{},notificationId:paidNotice.id,send:async()=>{throw new Error('must not resend');}});
      assert.equal((await db.query('SELECT count(*)::int AS n FROM message_logs')).rows[0].n,1);
    });
    await t.test('renewal needs authenticated payment and approval; a second worker never invokes provider again',async()=>{
      const renewal=(await db.query('SELECT * FROM renewal_jobs')).rows[0];
      const input={renewalId:renewal.id,correlationId:randomUUID(),requiresApproval:true};
      await assert.rejects(claimRenewalExecution(db,input),/RENEWAL_APPROVAL_REQUIRED/);
      await db.query('UPDATE renewal_jobs SET approved_at=now() WHERE id=$1',[renewal.id]);
      assert.equal((await claimRenewalExecution(db,input)).claimed,true);
      await assert.rejects(claimRenewalExecution(db,input),/RENEWAL_RESULT_REQUIRES_REVIEW/);
      assert.equal((await db.query('SELECT attempts FROM renewal_jobs')).rows[0].attempts,1);
    });
    await t.test('a lost checkout response recovers by reference after restart without another mutation',async()=>{
      await db.query("UPDATE charges SET status='cancelled' WHERE id=$1",[checkout.charge_id]);
      await db.query("UPDATE subscriptions SET expires_on='2026-11-06' WHERE id=$1",[subscription]);
      let calls=0,recovery;
      const uncertain=new LiveBillingAutomation({db,assertEnabled:async()=>{},createCheckout:async charge=>{
        calls++;recovery={id:'synthetic-recovered',checkoutUrl:'https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=recovered',simulated:false};
        assert.equal((await db.query('SELECT state FROM live_checkout_operations WHERE charge_id=$1',[charge.id])).rows[0].state,'CREATING');
        throw new Error('lost response after provider accepted');},recoverCheckout:async()=>recovery});
      await assert.rejects(uncertain.requestPayment({customer_id:customer}),/lost response/);
      const recovered=await uncertain.requestPayment({customer_id:customer});assert.match(recovered.checkout_url,/recovered/);assert.equal(calls,1);
    });
    await t.test('existing human support survives the chatbot upgrade without leaking to another customer',async()=>{
      await db.query("INSERT INTO conversation_sessions(whatsapp_e164,state,expires_at) VALUES('5511999999999','support',now()+interval '1 day')");
      const repository=new PgConversationAgentRepository(db);
      const handoff=await repository.activeHandoff('whatsapp:5511999999999',customer);assert.equal(handoff.status,'REQUESTED');
      assert.equal((await repository.activeHandoff('whatsapp:5511999999999',customer)).handoff_id,handoff.handoff_id);
      assert.equal(await repository.activeHandoff('whatsapp:5511999999999',randomUUID()),null);
      assert.equal((await db.query('SELECT count(*)::int AS n FROM conversation_handoffs')).rows[0].n,1);
    });
  } finally {await pg.close();}
});

test('live mode is limited to the canonical production environment and cannot replace fake-only guards',()=>{
  const env={NODE_ENV:'production',GATE_TEST_MODE:'false',PROVIDER_MODE:'live',RAILWAY_PROJECT_ID:'a0f107fe-acaf-459f-a640-38ef6010d1e5',RAILWAY_ENVIRONMENT_ID:'697f58fb-5084-4cb3-bd9a-ecdbc921b7bc'};
  assert.equal(liveBillingContext(env),true);
  for(const patch of [{NODE_ENV:'test'},{GATE_TEST_MODE:'true'},{PROVIDER_MODE:'fake-only'},{RAILWAY_PROJECT_ID:'another-project'},
    {RAILWAY_ENVIRONMENT_ID:'3f3188fb-0289-4f4d-93b9-574cfe1505f5'}]) {
    assert.equal(liveBillingContext({...env,...patch}),false);
    assert.throws(()=>createBillingAutomation({db:{},config:{GATE_LIVE_BILLING_ENABLED:true},env:{...env,...patch}}),/LIVE_BILLING_CONTEXT_REJECTED/);
  }
  assert.equal(moneyInCents('30.10'),3010);assert.throws(()=>moneyInCents('30.001'));
});
