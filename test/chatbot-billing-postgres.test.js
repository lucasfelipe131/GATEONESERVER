import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { migrateDatabase } from '../src/migrations.js';
import { createSimulationBilling } from '../src/services/billing-automation.js';
import { PgConversationAgentRepository } from '../src/services/conversation-operations.js';
import { GateConversationAgent } from '../src/services/conversation-agent.js';
import { ConversationToolRegistry } from '../src/services/conversation-tools.js';
import { createCustomerContextSnapshot } from '../src/services/customer-context.js';
import { getCustomerContext, paymentOperationStatus, renewalOperationStatus } from '../src/services/gate-core.js';
import { PaymentWatcher } from '../src/services/payment-watcher.js';
import { startStagingOutbox } from '../src/services/staging-outbox.js';
import {verifyExistingStaging} from '../scripts/staging07-verify.js';

const env = {NODE_ENV:'test',GATE_ENVIRONMENT:'test',SUPPORT_AGENT_ENABLED:'true',PROVIDER_MODE:'fake-only',
  PAYMENT_MODE:'simulation',WHATSAPP_MODE:'simulation',BITPANEL_MODE:'disabled',GATE_TEST_MODE:'true'};
const config = {BILLING_AUTOMATION_ENABLED:true,PAYMENT_MODE:'simulation',WHATSAPP_MODE:'simulation',
  BITPANEL_MODE:'disabled',PUBLIC_BASE_URL:'https://staging.example'};

function adapter(pg) {
  const client = pg => ({query:async (sql,params) => {
    if (!params && /;\s*\S/.test(sql.trim().replace(/;$/,''))) {
      const r = (await pg.exec(sql)).at(-1); return {...r,rowCount:r.rowCount ?? r.affectedRows ?? r.rows.length};
    }
    const r = await pg.query(sql,params); return {...r,rowCount:r.rowCount ?? r.affectedRows ?? r.rows.length};
  }});
  return {...client(pg),transaction:fn => pg.transaction(tx => fn(client(tx)))};
}

async function runtime(db, billing, customerId, conversationId = `test:${customerId}`) {
  const repository = new PgConversationAgentRepository(db);
  const statusInput = i => ({customerId:i.customer_id,subscriptionId:i.subscription_id || null});
  const registry = new ConversationToolRegistry({handlers:{
    resolveCustomer:async () => ({status:'MATCHED',customer_id:customerId}),
    getCustomerContext:i => createCustomerContextSnapshot(db,{customerId:i.customer_id,purpose:i.purpose,
      channel:'WHATSAPP',requestedScopes:i.requested_scopes,correlationId:i.correlation_id}),
    getSubscription:async i => {const c = await getCustomerContext(db,i.customer_id); return {...c,status:c.subscription_status};},
    getPaymentStatus:i => paymentOperationStatus(db,statusInput(i)),
    getRenewalStatus:i => renewalOperationStatus(db,statusInput(i)),
    requestRenewal:i => renewalOperationStatus(db,statusInput(i)),
    createPaymentRequest:i => billing.requestPayment(i),
    requestHumanHandoff:i => repository.requestHandoff(i)
  }});
  const agent = new GateConversationAgent({repository,registry});
  return {repository,turn:(text,messageId = randomUUID(),contentType = 'TEXT') => agent.process({
    conversationId,messageId,text,contentType,identity:{type:'WHATSAPP',provider:'whatsapp',value:'synthetic'},correlationId:randomUUID()})};
}

test('chatbot and automatic billing share durable PostgreSQL operations and configured simulation checkout', async t => {
  const pg = new PGlite({extensions:{pgcrypto}});
  const db = adapter(pg);
  let outbox;
  try {
    await migrateDatabase(db);
    for (const [key,value] of Object.entries({payment_mode:'simulation',whatsapp_mode:'simulation',bitpanel_mode:'disabled'})) {
      await db.query('INSERT INTO system_settings(key,value) VALUES($1,$2::jsonb)',[key,JSON.stringify(value)]);
    }
    const customerId = randomUUID(), otherId = randomUUID(), subscriptionId = randomUUID(), planId = randomUUID();
    await db.query("INSERT INTO plans(id,code,name,duration_months,price_cents) VALUES($1,'monthly','Mensal',1,3000)",[planId]);
    for (const id of [customerId,otherId]) await db.query(`INSERT INTO customers(id,name,whatsapp_e164,status,consent_contact,automation_eligible)
      VALUES($1,'Cliente Sintético',$2,'active',true,true)`,[id,`fake-${id}`]);
    await db.query("INSERT INTO subscriptions(id,customer_id,plan_id,status,expires_on) VALUES($1,$2,$3,'active','2026-10-06')",[subscriptionId,customerId,planId]);
    const billing = createSimulationBilling({db,config,env});
    let bot = await runtime(db,billing,customerId);
    let charge, payment;
    await t.test('renewal creates one persisted charge, payment and waiting renewal with simulation label',async () => {
      const result = await bot.turn('quero renovar','first');
      assert.equal(result.proposed_action,'createPaymentRequest',JSON.stringify(result));
      assert.equal(result.response_facts.payment_status,'PENDING');
      assert.match(result.response_text,/\[Simulação\][\s\S]*https:\/\/staging.example\/pagamento/);
      assert.equal(result.conversation_state,'waiting_payment');
      charge = (await db.query('SELECT * FROM charges')).rows[0];
      payment = (await db.query('SELECT * FROM payments')).rows[0];
      assert.match(charge.mercado_pago_preference_id,/^SIM-PREF-/);
      assert.equal((await db.query('SELECT count(*)::int AS n FROM renewal_jobs')).rows[0].n,1);
    });
    await t.test('duplicate message, another request, restart and contextual resend preserve the same link',async () => {
      const duplicate = await bot.turn('quero renovar','first'); assert.equal(duplicate.duplicate,true);
      assert.equal(duplicate.conversation_state,'waiting_payment');
      const second = await bot.turn('manda o pix'); assert.ok(second.response_text.includes(charge.checkout_url));
      bot = await runtime(db,billing,customerId);
      const resend = await bot.turn('e o link?'); assert.equal(resend.intent,'PAYMENT_REQUEST');
      assert.ok(resend.response_text.includes(charge.checkout_url));
      assert.equal((await db.query('SELECT count(*)::int AS n FROM payments')).rows[0].n,1);
      assert.equal((await db.query('SELECT count(*)::int AS n FROM charges')).rows[0].n,1);
    });
    await t.test('text or receipt without caption never confirms payment or starts provisioning',async () => {
      for (const [text,type] of [['paguei','TEXT'],['','IMAGE'],['','PDF']]) {
        const result = await bot.turn(text,randomUUID(),type);
        assert.equal(result.response_facts.payment_status,'PENDING',JSON.stringify(result));
        assert.doesNotMatch(result.response_text,/pagamento (foi )?confirmado|concluída/i);
      }
      assert.equal((await db.query('SELECT count(*)::int AS n FROM provisioning_operations')).rows[0].n,0);
    });
    await t.test('all four reminders share one charge, and two workers and repeat scans cannot duplicate notifications',async () => {
      for (const date of ['2026-10-03','2026-10-06','2026-10-08','2026-10-11']) {
        const results = await Promise.all([billing.scanReminders({now:new Date(`${date}T12:00:00Z`)}),
          billing.scanReminders({now:new Date(`${date}T12:00:00Z`)})]);
        assert.equal(results.reduce((n,r) => n + r.notifications,0),1,JSON.stringify(results));
        assert.equal(results.reduce((n,r) => n + r.errors,0),0,JSON.stringify(results));
      }
      const notices = (await db.query("SELECT context FROM notification_requests WHERE intention='BILLING_REMINDER'")).rows;
      assert.equal(notices.length,4);
      assert.equal(new Set(notices.map(n => n.context.charge_id)).size,1);
      assert.ok(notices.every(n => n.context.text.includes(charge.checkout_url)));
      assert.equal((await db.query('SELECT count(*)::int AS n FROM charges')).rows[0].n,1);
    });
    await t.test('cross-customer request and mode change roll back without billing side effects',async () => {
      await assert.rejects(billing.requestPayment({customer_id:otherId,subscription_id:subscriptionId}),{code:'SUBSCRIPTION_NOT_FOUND'});
      await db.query(`UPDATE system_settings SET value='"live"'::jsonb WHERE key='payment_mode'`);
      await assert.rejects(billing.requestPayment({customer_id:customerId}),{code:'BILLING_SIMULATION_SETTINGS_MISMATCH'});
      await db.query(`UPDATE system_settings SET value='"simulation"'::jsonb WHERE key='payment_mode'`);
      assert.equal((await db.query('SELECT count(*)::int AS n FROM payments')).rows[0].n,1);
    });
    await t.test('only verified provider confirmation pays the charge; late pending event cannot regress it',async () => {
      const watcher = new PaymentWatcher({db,providerName:'fake'});
      const event = {externalPaymentId:payment.external_payment_id,status:'CONFIRMED',amountCents:3000,customerId,subscriptionId};
      const rejected = await watcher.observe({...event,externalEventId:'untrusted'},{correlationId:randomUUID()});
      assert.equal(rejected.review,'UNTRUSTED_CONFIRMATION_SOURCE');
      assert.equal((await db.query('SELECT status FROM charges WHERE id=$1',[charge.id])).rows[0].status,'approved');
      const confirmed = {...event,externalEventId:'verified'};
      await watcher.observe(confirmed,{providerVerified:true,correlationId:randomUUID()});
      assert.equal((await watcher.observe(confirmed,{providerVerified:true,correlationId:randomUUID()})).duplicate,true);
      const stale = await watcher.observe({...event,status:'PENDING',externalEventId:'late-pending'},{providerVerified:true,correlationId:randomUUID()});
      assert.equal(stale.changed,false); assert.equal(stale.status,'CONFIRMED');
      assert.equal((await db.query('SELECT status FROM charges WHERE id=$1',[charge.id])).rows[0].status,'paid');
      assert.equal((await billing.scanReminders({now:new Date('2026-10-06T12:00:00Z')})).notifications,0);
    });
    await t.test('existing outbox completes and verifies renewal before chatbot announces completion',async () => {
      outbox = startStagingOutbox({db,env:{...env,GATE_ENVIRONMENT:'staging-unified',
        RAILWAY_PROJECT_ID:'a0f107fe-acaf-459f-a640-38ef6010d1e5',
        RAILWAY_ENVIRONMENT_ID:'3f3188fb-0289-4f4d-93b9-574cfe1505f5',
        GLOBAL_PAUSE:'true',AI_ADMIN_ENABLED:'false',AI_WHATSAPP_ENABLED:'false',
        TELEGRAM_SYNC_ENABLED:'false',OUTBOX_DISPATCHER_ENABLED:'true'},workerId:'unified-stage-test',
        logger:{info(){},warn(){},error(){}}});
      const deadline = Date.now() + 20000;
      let state;
      do {
        state = (await db.query('SELECT state FROM renewal_sagas WHERE customer_id=$1',[customerId])).rows[0]?.state;
        if (state !== 'COMPLETED') await new Promise(resolve => setTimeout(resolve,100));
      } while (state !== 'COMPLETED' && Date.now() < deadline);
      assert.equal(state,'COMPLETED');
      const completed = await bot.turn('já renovou?');
      assert.match(completed.response_text,/concluída e verificada/);
      assert.equal((await db.query('SELECT count(*)::int AS n FROM provisioning_operations')).rows[0].n,1);
    });
    await t.test('three unclear turns escalate once and active handoff prevents a subsequent payment action',async () => {
      const conversationId = 'unclear:test';
      const unclear = await runtime(db,billing,customerId,conversationId);
      await unclear.turn('abacaxi azul'); await unclear.turn('girassol roxo');
      const escalation = await unclear.turn('pipoca verde');
      assert.equal(escalation.outcome,'HANDOFF_CREATED',JSON.stringify(escalation));
      assert.ok(escalation.response_facts.handoff_id);
      const resumed = await runtime(db,billing,customerId,conversationId);
      const followup = await resumed.turn('quero renovar');
      assert.equal(followup.outcome,'HANDOFF_PENDING');
      assert.equal((await db.query('SELECT count(*)::int AS n FROM conversation_handoffs WHERE conversation_id=$1',[conversationId])).rows[0].n,1);
    });
    await t.test('human request takes priority over payment evidence in a caption',async () => {
      const human = await runtime(db,billing,customerId,'human:test');
      const result = await human.turn('paguei mas quero falar com atendente',randomUUID(),'IMAGE');
      assert.equal(result.intent,'HUMAN_REQUEST'); assert.equal(result.outcome,'HANDOFF_CREATED');
      assert.ok(!result.tool_calls.some(call => call.tool === 'createPaymentRequest'));
    });
    await t.test('staging verification uses a verified existing login when no WhatsApp identity exists',async () => {
      await db.query('UPDATE customers SET whatsapp_e164=NULL WHERE id=$1',[customerId]);
      await db.query(`INSERT INTO customer_identities(customer_id,identity_type,provider,external_id,normalized_value,verified_at)
        VALUES($1,'LOGIN','core','existing-synthetic-login','existing-synthetic-login',now())`,[customerId]);
      const result=await verifyExistingStaging({db,config,env});
      assert.equal(result.customers_verified,1);
      assert.deepEqual(result.before,result.after);
      assert.equal(result.real_payment_requests,0);
    });
    await t.test('opt-out customer receives no reminders or new charges',async () => {
      await db.query("INSERT INTO subscriptions(customer_id,plan_id,status,expires_on) VALUES($1,$2,'active','2026-10-03')",[otherId,planId]);
      await db.query('UPDATE customers SET opt_out_at=now() WHERE id=$1',[otherId]);
      const scanned = await billing.scanReminders({now:new Date('2026-10-03T12:00:00Z')});
      assert.equal(scanned.notifications,0);
      assert.equal((await db.query('SELECT count(*)::int AS n FROM payments WHERE customer_id=$1',[otherId])).rows[0].n,0);
    });
  } finally {await outbox?.stop(); await pg.close();}
});

test('automatic billing is opt-in and cannot run against production or live settings',() => {
  assert.equal(createSimulationBilling({db:{},config:{...config,BILLING_AUTOMATION_ENABLED:false},env:{}}),null);
  for (const unsafe of [{...env,NODE_ENV:'production'}, {...env,PAYMENT_MODE:'live'}, {...env,GATE_ENVIRONMENT:'production'}]) {
    assert.throws(() => createSimulationBilling({db:{},config,env:unsafe}),{code:'BILLING_SIMULATION_GUARD_FAILED'});
  }
});
