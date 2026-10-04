import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { GateConversationAgent } from '../src/services/conversation-agent.js';
import { GuidedSupportAgent } from '../src/services/support-guidance.js';
import { InMemoryConversationAgentRepository } from '../src/services/conversation-operations.js';
import { ConversationToolRegistry } from '../src/services/conversation-tools.js';
import { safeResponseForFacts, validateConversationResponse } from '../src/core/conversation-responses.js';

const customerId = '10000000-0000-4000-8000-000000000001';
function runtime({ repository = new InMemoryConversationAgentRepository(), profile = null, error = null } = {}) {
  let opens = 0, mutations = 0;
  const cases = [];
  const registry = new ConversationToolRegistry({ handlers: {
    resolveCustomer: async () => ({ status: 'MATCHED', customer_id: customerId }),
    getCustomerContext: async () => ({ contract: 'ContextSnapshot.v1', context_snapshot_id: '20000000-0000-4000-8000-000000000002', customer360: {
      customer_id: customerId, identity: { name: { value: 'Ana' } }, context_status: 'COMPLETE',
      subscription: { subscription_id: '30000000-0000-4000-8000-000000000003', status: { value: 'active' }, expires_at: { value: '2026-11-01' } },
      memories: profile ? [{ key: 'self_registration.profile', source: 'WHATSAPP_SELF_REGISTRATION', value: profile }] : [],
      conversation: { recent_messages: [] }
    } }),
    getOpenSupportCases: async () => cases,
    openSupportCase: async () => { opens++; const c = { support_case_id: 'case-1' }; cases.push(c); return c; },
    requestHumanHandoff: input => repository.requestHandoff(input),
    getSubscription: async () => ({ customer_id: customerId, subscription_id: '30000000-0000-4000-8000-000000000003' }),
    getRenewalStatus: async () => ({ decision: 'PAYMENT_REQUIRED' }),
    requestRenewal: async () => ({ decision: 'PAYMENT_REQUIRED' }),
    createPaymentRequest: async () => { mutations++; throw Object.assign(new Error(error), { code: error }); }
  } });
  const agent = new GateConversationAgent({ repository, registry, supportAgent: new GuidedSupportAgent() });
  return { repository, counts: () => ({ opens, mutations }),
    turn: (text, messageId = randomUUID(), conversationId = 'support:test') => agent.process({
      conversationId, messageId, text, identity: { type: 'WHATSAPP', value: 'synthetic', provider: 'whatsapp' }
    }) };
}

test('guided support asks for device/app, gives concrete checks, resumes after restart and hands off unresolved context', async () => {
  let bot = runtime();
  let r = await bot.turn('sem sinal', 'begin'); assert.equal(r.conversation_state, 'support_device'); assert.match(r.response_text, /marca\/modelo/);
  assert.equal((await bot.turn('sem sinal', 'begin')).duplicate, true);
  r = await bot.turn('TV Samsung'); assert.equal(r.conversation_state, 'support_application');
  r = await bot.turn('Smart One'); assert.equal(r.conversation_state, 'support_scope');
  const repo = bot.repository;
  bot = runtime({ repository: repo });
  r = await bot.turn('1', 'after-restart'); assert.equal(r.conversation_state, 'support_result');
  assert.match(r.response_text, /TV Samsung.*YouTube/); assert.match(r.response_text, /Smart One/);
  assert.equal(validateConversationResponse(r.response_text, r.response_facts).allowed, true);
  r = await bot.turn('não funcionou'); assert.equal(r.outcome, 'HANDOFF_CREATED'); assert.ok(r.response_facts.handoff_id);
  const h = await repo.activeHandoff('support:test', customerId); assert.match(h.summary, /TV Samsung.*Smart One.*ALL/);
  assert.equal(bot.counts().mutations, 0);
  r = await bot.turn('oi'); assert.equal(r.outcome, 'HANDOFF_PENDING');
});

test('own registered profile avoids asking again; customer-reported recovery is never a verified resolution', async () => {
  const bot = runtime({ profile: { device: 'TV LG', application: 'App Teste' } });
  let r = await bot.turn('está travando'); assert.equal(r.conversation_state, 'support_scope'); assert.match(r.response_text, /TV LG.*App Teste/);
  r = await bot.turn('2'); assert.match(r.response_text, /outro canal/);
  r = await bot.turn('funcionou'); assert.equal(r.outcome, 'CUSTOMER_REPORTED_RECOVERY');
  assert.equal(r.response_facts.verification_result, 'CUSTOMER_REPORTED'); assert.notEqual(r.response_facts.case_status, 'RESOLVED');
  assert.equal(validateConversationResponse(r.response_text, r.response_facts).allowed, true);
  assert.equal(bot.counts().opens, 1); assert.equal(bot.counts().mutations, 0);
  r = await bot.turn('TV Samsung', 'other-phone', 'support:other'); assert.notEqual(r.conversation_state, 'support_application');
});

test('human and billing requests interrupt triage; repeated questions retain the requested next step', async () => {
  const bot = runtime({ error: 'PENDING_PAYMENT_PLAN_CONFLICT' });
  await bot.turn('sem sinal');
  let r = await bot.turn('sem sinal'); assert.equal(r.outcome, 'SUPPORT_GUIDANCE'); assert.match(r.response_text, /marca\/modelo/);
  r = await bot.turn('quero renovar'); assert.equal(r.response_facts.error_code, 'PENDING_PAYMENT_PLAN_CONFLICT');
  assert.match(r.response_text, /outro plano.*QUERO RENOVAR.*ATENDENTE/);
  r = await bot.turn('atendente'); assert.equal(r.outcome, 'HANDOFF_CREATED'); assert.ok(r.response_facts.handoff_id);
});

test('missing subscription or uncertain checkout returns an actionable response without asserting payment or renewal', () => {
  for (const error_code of ['SUBSCRIPTION_NOT_FOUND', 'CHECKOUT_RESULT_REQUIRES_REVIEW', 'CHECKOUT_IN_PROGRESS', 'SIMULATED_PAYMENT_REJECTED']) {
    const text = safeResponseForFacts({ error_code });
    assert.match(text, /CADASTRO|ATENDENTE|QUERO RENOVAR/);
    assert.equal(validateConversationResponse(text, { error_code }).allowed, true);
  }
});
