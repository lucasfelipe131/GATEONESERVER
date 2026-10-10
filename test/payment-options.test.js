import test from 'node:test';
import assert from 'node:assert/strict';
import { getMercadoPagoPaymentOptions } from '../src/integrations/mercadopago.js';
import { understandRequest } from '../src/core/conversation-intents.js';
import { ConversationToolRegistry } from '../src/services/conversation-tools.js';
import { GateConversationAgent } from '../src/services/conversation-agent.js';
import { InMemoryConversationAgentRepository } from '../src/services/conversation-operations.js';
import { RenewalAgent } from '../src/services/renewal-agent.js';

test('payment questions stay read-only; explicit card/boleto requests permit billing', () => {
  for (const text of ['7', 'quais formas de pagamento?', 'aceita pix?', 'posso pagar no cartão?',
    'tem boleto?', 'quero saber como pagar', 'cartão ou pix?', 'quero parcelar']) {
    const result = understandRequest(text);
    assert.equal(result.primary_intent, 'PAYMENT_METHODS_QUERY', text);
    assert.ok(!result.intents.some(i => ['PAYMENT_REQUEST', 'RENEWAL_REQUEST'].includes(i.name)), text);
  }
  for (const text of ['quero pagar', 'quero pagar no cartão', 'manda o boleto', 'cartão', 'boleto', 'pix']) {
    assert.equal(understandRequest(text).primary_intent, 'PAYMENT_REQUEST', text);
  }
  for (const text of ['não quero pagar no cartão', 'não gere boleto', 'quanto custa renovar trimestral?']) {
    assert.ok(!understandRequest(text).intents.some(i => ['PAYMENT_REQUEST', 'RENEWAL_REQUEST'].includes(i.name)), text);
  }
  assert.equal(understandRequest('quero renovar trimestral no cartão').primary_intent, 'PAYMENT_REQUEST');
  assert.equal(understandRequest('quero o plano trimestral').primary_intent, 'RENEWAL_REQUEST');
  assert.equal(understandRequest('plano semestral').primary_intent, 'RENEWAL_REQUEST');
  assert.ok(!understandRequest('quero renovar mensal ou anual').intents.some(i => ['PAYMENT_REQUEST', 'RENEWAL_REQUEST'].includes(i.name)));
  assert.equal(understandRequest('mensal').primary_intent, 'RENEWAL_REQUEST');
});

test('method catalog uses authenticated API, only active known methods, and no mutations', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let requests = 0;
  globalThis.fetch = async (url, options) => {
    requests++;
    assert.equal(url, 'https://api.mercadopago.com/v1/payment_methods');
    assert.equal(options.method, undefined);
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer APP_USR-synthetic');
    return { ok: true, json: async () => [
      { id: 'pix', status: 'active', payment_type_id: 'bank_transfer' },
      { id: 'visa', status: 'active', payment_type_id: 'credit_card' },
      { id: 'bolbradesco', status: 'inactive', payment_type_id: 'ticket' },
      { id: 'unknown', status: 'active', payment_type_id: 'ticket' }
    ] };
  };
  const simulation = await getMercadoPagoPaymentOptions({ PAYMENT_MODE: 'simulation' });
  assert.equal(simulation.simulated, true); assert.equal(requests, 0);
  const config = { PAYMENT_MODE: 'live', MERCADOPAGO_ACCESS_TOKEN: 'APP_USR-synthetic',
    MERCADOPAGO_WEBHOOK_SECRET: 'synthetic-secret', PUBLIC_BASE_URL: 'https://synthetic.example' };
  assert.deepEqual((await getMercadoPagoPaymentOptions(config)).methods, ['Pix', 'Cartão de crédito']);
  globalThis.fetch = async () => ({ ok: false, json: async () => ({ message: 'unavailable' }) });
  await assert.rejects(getMercadoPagoPaymentOptions(config), { code: 'PAYMENT_OPTIONS_UNAVAILABLE' });
});

test('unregistered sender can inspect payment options without creating money or asking identity', async () => {
  const repository = new InMemoryConversationAgentRepository();
  let reads = 0;
  const registry = new ConversationToolRegistry({ handlers: {
    resolveCustomer: async () => ({ status: 'NOT_FOUND' }),
    getPaymentOptions: async () => { reads++; return { provider: 'Mercado Pago', methods: ['Pix', 'Cartão de crédito', 'Boleto'], simulated: false }; },
    createPaymentRequest: async () => { throw new Error('must not create'); }
  } });
  const agent = new GateConversationAgent({ repository, registry });
  const input = { conversationId: 'synthetic-options', messageId: 'one', text: 'aceita boleto?',
    identity: { type: 'WHATSAPP', provider: 'whatsapp', value: 'synthetic' } };
  const reply = await agent.process(input);
  assert.equal(reply.proposed_action, 'getPaymentOptions');
  assert.match(reply.response_text, /Pix, Cartão de crédito, Boleto/);
  assert.match(reply.response_text, /Nunca envie/);
  assert.doesNotMatch(reply.response_text, /seu login/);
  assert.equal((await agent.process(input)).duplicate, true); assert.equal(reads, 1);
});

test('selected plan renews rather than listing catalog; pending card/boleto requests reuse one charge', async () => {
  const agent = new RenewalAgent();
  const customer360 = { subscription: { subscription_id: 'sub' } };
  const context = { idempotency_key: 'synthetic', correlation_id: 'synthetic', plan_code: 'quarterly' };
  let creates = 0;
  let pending = false;
  const turn = { execute: async (name, input) => {
    if (name === 'listPlans') throw new Error('selected plan must not list plans');
    if (name === 'getSubscription') return { subscription_id: 'sub' };
    if (['getRenewalStatus', 'requestRenewal'].includes(name)) return { decision: pending ? 'PAYMENT_PENDING' : 'PAYMENT_REQUIRED' };
    if (name === 'createPaymentRequest') {
      creates++; assert.equal(input.plan_code, 'quarterly');
      return { status: 'PENDING', charge_id: 'charge', plan_name: 'Trimestral', checkout_url: 'https://www.mercadopago.com.br/synthetic', amount_cents: 8500 };
    }
    if (name === 'getPaymentStatus') return { status: 'PENDING', charge_id: 'charge', plan_code: 'quarterly',
      plan_name: 'Trimestral', checkout_url: 'https://www.mercadopago.com.br/synthetic', amount_cents: 8500 };
    throw new Error(name);
  } };
  const run = (text, ctx = context) => agent.handle({ intentResult: understandRequest(text), customerId: 'customer', customer360, turn, facts: {}, context: ctx });
  const first = await run('quero renovar trimestral no cartão');
  assert.equal(first.proposed_action, 'createPaymentRequest'); assert.equal(creates, 1);
  pending = true;
  const second = await run('manda o boleto');
  assert.equal(second.facts.checkout_url, first.facts.checkout_url); assert.equal(creates, 1);
  await assert.rejects(run('quero renovar mensal', { ...context, plan_code: 'monthly' }), { code: 'PENDING_PAYMENT_PLAN_CONFLICT' });
  assert.equal(creates, 1);
});

test('pending checkout without a link invokes durable recovery, preserving the charge', async () => {
  const agent = new RenewalAgent(); let recoveries = 0;
  const result = await agent.handle({ intentResult: understandRequest('manda o pix'), customerId: 'customer',
    customer360: { subscription: { subscription_id: 'sub' } }, facts: {},
    context: { idempotency_key: 'synthetic', correlation_id: 'synthetic' },
    turn: { execute: async name => {
      if (name === 'getSubscription') return { subscription_id: 'sub' };
      if (name === 'getRenewalStatus') return { decision: 'PAYMENT_PENDING' };
      if (name === 'getPaymentStatus') return { status: 'PENDING', charge_id: 'original-charge' };
      if (name === 'createPaymentRequest') { recoveries++; return { charge_id: 'original-charge', status: 'PENDING', checkout_url: 'https://www.mercadopago.com.br/synthetic' }; }
      throw new Error(name);
    } }
  });
  assert.equal(recoveries, 1); assert.match(result.facts.checkout_url, /mercadopago/);
  assert.equal(result.facts.operation_state, 'EXISTING_PAYMENT');
});
