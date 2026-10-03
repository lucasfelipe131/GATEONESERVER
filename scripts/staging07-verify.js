import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createDb} from '../src/db.js';
import {loadConfig} from '../src/config.js';
import {verifyMigrations} from '../src/migrations.js';
import {localSupportEnabled} from '../src/services/support-repository.js';
import {credentialStatus} from '../src/integrations/runtime-config.js';
import {createSimulationBilling} from '../src/services/billing-automation.js';
import {PgConversationAgentRepository} from '../src/services/conversation-operations.js';
import {GateConversationAgent} from '../src/services/conversation-agent.js';
import {ConversationToolRegistry} from '../src/services/conversation-tools.js';
import {createCustomerContextSnapshot} from '../src/services/customer-context.js';
import {getCustomerContext,paymentOperationStatus,renewalOperationStatus,resolveIdentity} from '../src/services/gate-core.js';

const env = process.env;
assert.equal(localSupportEnabled(env),true);
assert.equal(env.GATE_ENVIRONMENT,'staging-055');
assert.equal(env.RAILWAY_SERVICE_ID,'13d818b3-c24e-47c8-a617-4a7ae8ca21f3');
assert.equal(new URL(env.DATABASE_URL).hostname,'postgres.railway.internal');
const config = loadConfig();
const db = createDb(config.DATABASE_URL,{ssl:config.DATABASE_SSL});
const log = (event,data) => console.log(JSON.stringify({event,...data}));
try {
  assert.equal((await verifyMigrations(db)).ready,true);
  const counts = async () => (await db.query(`SELECT
    (SELECT count(*)::int FROM customers) customers,(SELECT count(*)::int FROM subscriptions) subscriptions,
    (SELECT count(*)::int FROM charges) charges,(SELECT count(*)::int FROM payments) payments,
    (SELECT count(*)::int FROM renewal_jobs) renewals`)).rows[0];
  const before = await counts();
  const credentials = await credentialStatus(db,config);
  log('staging07.integrations',{configured:credentials.configured,presence:{
    mercado_pago_token:Boolean(credentials.runtime.MERCADOPAGO_ACCESS_TOKEN),
    mercado_pago_webhook_secret:Boolean(credentials.runtime.MERCADOPAGO_WEBHOOK_SECRET),
    whatsapp_qr_endpoint:Boolean(credentials.runtime.GATE_ONE_WHATSAPP_QR_URL),
    whatsapp_qr_notify_secret:Boolean(credentials.runtime.GATE_ONE_WHATSAPP_NOTIFY_SECRET)
  }});
  const billing = createSimulationBilling({db,config:{...credentials.runtime,BILLING_AUTOMATION_ENABLED:true}});
  const repository = new PgConversationAgentRepository(db);
  const customers = await db.query(`SELECT c.id,c.whatsapp_e164 FROM customers c
    WHERE c.status='active' AND c.whatsapp_e164 IS NOT NULL
    AND EXISTS(SELECT 1 FROM subscriptions s WHERE s.customer_id=c.id AND s.status IN ('active','late'))
    ORDER BY c.created_at LIMIT 3`);
  let verified = 0,unresolved = 0;
  for (const customer of customers.rows) {
    const identity = {type:'WHATSAPP',provider:'whatsapp',value:customer.whatsapp_e164};
    const resolution = await resolveIdentity(db,identity);
    if (resolution.status !== 'MATCHED' || resolution.customer_id !== customer.id) {unresolved++;continue;}
    const scoped = i => ({customerId:i.customer_id,subscriptionId:i.subscription_id || null});
    const registry = new ConversationToolRegistry({handlers:{
      resolveCustomer:i => resolveIdentity(db,i),
      getCustomerContext:i => createCustomerContextSnapshot(db,{customerId:i.customer_id,purpose:i.purpose,channel:'WHATSAPP',requestedScopes:i.requested_scopes,correlationId:i.correlation_id}),
      getSubscription:async i => {const s=await getCustomerContext(db,i.customer_id);return {...s,status:s.subscription_status};},
      getPaymentStatus:i => paymentOperationStatus(db,scoped(i)),
      getRenewalStatus:i => renewalOperationStatus(db,scoped(i)),
      requestRenewal:i => renewalOperationStatus(db,scoped(i)),
      createPaymentRequest:i => billing.requestPayment(i),
      requestHumanHandoff:i => repository.requestHandoff(i)
    }});
    const agent = new GateConversationAgent({repository,registry});
    const correlationId=randomUUID(),conversationId=`staging07-verify:${customer.id}:${correlationId}`;
    const turn = (text,messageId) => agent.process({conversationId,messageId,text,identity,correlationId});
    const pending = await turn('já caiu meu pagamento?','payment-status');
    assert.equal(pending.customer_id,customer.id);
    assert.ok(!pending.tool_calls?.some(c => c.tool === 'createPaymentRequest'));
    const duplicate = await turn('já caiu meu pagamento?','payment-status');
    assert.equal(duplicate.duplicate,true);
    assert.equal(duplicate.decision_id,pending.decision_id);
    const status = await renewalOperationStatus(db,{customerId:customer.id});
    if (status.decision !== 'PAYMENT_REQUIRED') {
      const renewal = await turn('quero renovar','renewal-existing');
      assert.ok(!renewal.tool_calls?.some(c => c.tool === 'createPaymentRequest'));
    }
    verified++;
  }
  const after = await counts();
  assert.deepEqual(after,before);
  log('staging07.existing_data_verified',{customers_verified:verified,identity_unresolved:unresolved,before,after,
    real_payment_requests:0,real_messages:0,fixtures_created:0});
  if (!verified) throw new Error('NO_EXISTING_CUSTOMER_VERIFIED');
} finally {await db.close();}
