import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { createCheckoutPreference, getMercadoPagoPaymentOptions } from '../src/integrations/mercadopago.js';
import { SimulationBillingAutomation } from '../src/services/billing-automation.js';
import { PgConversationAgentRepository } from '../src/services/conversation-operations.js';
import { GateConversationAgent } from '../src/services/conversation-agent.js';
import { ConversationToolRegistry } from '../src/services/conversation-tools.js';
import { createCustomerContextSnapshot } from '../src/services/customer-context.js';
import { getCustomerContext, paymentOperationStatus, renewalOperationStatus } from '../src/services/gate-core.js';

export async function verifyPaymentConversation({ db, config, env = process.env }) {
  assert.equal(env.RAILWAY_PROJECT_ID, 'a0f107fe-acaf-459f-a640-38ef6010d1e5');
  assert.equal(env.RAILWAY_ENVIRONMENT_ID, '3f3188fb-0289-4f4d-93b9-574cfe1505f5');
  assert.equal(env.GATE_TEST_MODE, 'true'); assert.equal(env.PROVIDER_MODE, 'fake-only');
  for (const key of ['PAYMENT_MODE', 'WHATSAPP_MODE']) {
    assert.equal(env[key], 'simulation'); assert.equal(config[key], 'simulation');
  }
  assert.equal(env.BITPANEL_MODE, 'disabled'); assert.equal(config.BITPANEL_MODE, 'disabled');
  const report = { commit: env.RAILWAY_GIT_COMMIT_SHA || null, verifiedAt: new Date().toISOString(),
    providerCalls: 0, messagesSent: 0, realCheckouts: 0, cases: [] };
  const rollback = new Error('PAYMENT_VERIFICATION_ROLLBACK');
  const count = async query => (await query(`SELECT
    (SELECT count(*)::int FROM customers) customers, (SELECT count(*)::int FROM subscriptions) subscriptions,
    (SELECT count(*)::int FROM charges) charges, (SELECT count(*)::int FROM payments) payments,
    (SELECT count(*)::int FROM renewal_jobs) renewals, (SELECT count(*)::int FROM agent_decisions) decisions`)).rows[0];
  const before = await count(sql => db.query(sql));
  try {
    await db.transaction(async client => {
      const isolated = { query: (...args) => client.query(...args), transaction: fn => fn(client) };
      const plans = (await client.query('SELECT * FROM plans WHERE active=true ORDER BY sort_order')).rows;
      assert.equal(plans.length, 4);
      const monthly = plans.find(p => p.code === 'monthly'); assert.ok(monthly);
      const assertEnabled = async () => {
        const modes = (await client.query("SELECT key,value FROM system_settings WHERE key IN ('payment_mode','whatsapp_mode','bitpanel_mode')")).rows;
        for (const row of modes) assert.equal(row.value, row.key === 'bitpanel_mode' ? 'disabled' : 'simulation');
      };
      const billing = new SimulationBillingAutomation({ db: isolated, baseUrl: config.PUBLIC_BASE_URL, assertEnabled,
        createCheckout: charge => createCheckoutPreference(config, charge) });
      for (const plan of plans) {
        const customerId = randomUUID(), subscriptionId = randomUUID();
        await client.query("INSERT INTO customers(id,name,status) VALUES($1,'Verificação Sintética de Pagamentos','active')", [customerId]);
        await client.query("INSERT INTO subscriptions(id,customer_id,plan_id,status,expires_on) VALUES($1,$2,$3,'active','2099-01-01')", [subscriptionId, customerId, monthly.id]);
        const repository = new PgConversationAgentRepository(isolated);
        const scope = i => ({ customerId: i.customer_id, subscriptionId: i.subscription_id || null });
        const registry = new ConversationToolRegistry({ handlers: {
          resolveCustomer: async () => ({ status: 'MATCHED', customer_id: customerId }),
          getCustomerContext: i => createCustomerContextSnapshot(isolated, { customerId, purpose: i.purpose,
            channel: 'WHATSAPP', requestedScopes: i.requested_scopes, correlationId: i.correlation_id }),
          getSubscription: async () => { const c = await getCustomerContext(isolated, customerId); return { ...c, status: c.subscription_status }; },
          getPaymentOptions: () => getMercadoPagoPaymentOptions(config),
          getPaymentStatus: i => paymentOperationStatus(isolated, scope(i)),
          getRenewalStatus: i => renewalOperationStatus(isolated, scope(i)),
          requestRenewal: i => renewalOperationStatus(isolated, scope(i)),
          createPaymentRequest: i => billing.requestPayment(i)
        } });
        const agent = new GateConversationAgent({ repository, registry });
        const turn = (text, messageId = randomUUID()) => agent.process({ conversationId: `synthetic-payments:${customerId}`,
          messageId, text, identity: { type: 'WHATSAPP', provider: 'whatsapp', value: 'synthetic-verifier' } });
        const questionsBefore = await count(sql => client.query(sql));
        const options = await turn('posso pagar no cartão?');
        assert.equal(options.proposed_action, 'getPaymentOptions');
        assert.deepEqual(await count(sql => client.query(sql)), { ...questionsBefore, decisions: questionsBefore.decisions + 1 });
        const messageId = randomUUID();
        const request = await turn(`quero renovar ${plan.name.toLowerCase()} no cartão`, messageId);
        assert.equal(request.proposed_action, 'createPaymentRequest', JSON.stringify(request));
        assert.equal(request.response_facts.amount_cents, plan.price_cents);
        assert.match(request.response_text, /\[Simulação\]/);
        const link = request.response_facts.checkout_url; assert.ok(link);
        assert.equal((await turn(`quero renovar ${plan.name.toLowerCase()} no cartão`, messageId)).duplicate, true);
        assert.equal((await turn('manda o boleto')).response_facts.checkout_url, link);
        assert.equal((await turn('manda o pix')).response_facts.checkout_url, link);
        assert.equal((await turn('paguei')).response_facts.payment_status, 'PENDING');
        assert.equal((await client.query('SELECT count(*)::int n FROM payments WHERE customer_id=$1', [customerId])).rows[0].n, 1);
        assert.equal((await client.query('SELECT plan_id FROM subscriptions WHERE id=$1', [subscriptionId])).rows[0].plan_id, monthly.id);
        report.cases.push({ plan: plan.code, amountCents: plan.price_cents, methodsQuery: 'READ_ONLY',
          repeatedRequests: 'SAME_CHARGE', receipt: 'PENDING_UNTIL_PROVIDER', subscription: 'UNCHANGED' });
      }
      throw rollback;
    });
  } catch (error) { if (error !== rollback) throw error; }
  assert.deepEqual(await count(sql => db.query(sql)), before);
  return { ...report, rolledBack: true, databaseCountsUnchanged: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadConfig(); const db = createDb(config.DATABASE_URL, { ssl: config.DATABASE_SSL });
  try { console.log('GATE_PAYMENT_CONVERSATION_VERIFY=' + JSON.stringify(await verifyPaymentConversation({ db, config }))); }
  finally { await db.close(); }
}
