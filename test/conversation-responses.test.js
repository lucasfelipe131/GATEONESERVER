import assert from 'node:assert/strict';
import test from 'node:test';
import {
  avoidRepeatedResponse,
  evaluateMemoryCandidate,
  renderConversationResponse,
  validateConversationResponse
} from '../src/core/conversation-responses.js';

test('payment pending nunca permite afirmar confirmação', () => {
  const facts = { payment_status: 'PENDING', renewal_status: null, expiration: null, handoff_id: null };
  assert.equal(validateConversationResponse('Seu pagamento foi confirmado.', facts).allowed, false);
  assert.match(renderConversationResponse({ intent: 'PAYMENT_STATUS', facts }), /Ainda não identifiquei/i);
});

test('renewal processing e verifying nunca antecipam conclusão', () => {
  for (const state of ['PROCESSING', 'VERIFYING']) {
    const facts = { payment_status: 'CONFIRMED', renewal_status: state, expiration: null, handoff_id: null };
    const response = renderConversationResponse({ intent: 'RENEWAL_STATUS', facts });
    assert.doesNotMatch(response, /concluída|sucesso/i);
    assert.equal(validateConversationResponse('Renovado com sucesso.', facts).allowed, false);
  }
});

test('completed permite confirmação somente depois da verificação', () => {
  const facts = {
    payment_status: 'CONFIRMED', renewal_status: 'COMPLETED',
    expiration: '2026-09-30', handoff_id: null
  };
  const response = renderConversationResponse({ intent: 'RENEWAL_STATUS', facts });
  assert.match(response, /concluída e verificada/i);
  assert.equal(validateConversationResponse(response, facts).allowed, true);
});

test('expiration null não permite inventar data', () => {
  const facts = { expiration: null, payment_status: null, renewal_status: null, handoff_id: null };
  const response = renderConversationResponse({ intent: 'EXPIRATION_QUERY', facts });
  assert.match(response, /não.*inventar/i);
  assert.equal(validateConversationResponse('Seu vencimento é 30/09/2026.', facts).allowed, false);
});

test('handoff só pode ser afirmado com identificador confirmado', () => {
  const missing = { handoff_id: null };
  const confirmed = { handoff_id: '10000000-0000-4000-8000-000000000001' };
  assert.equal(validateConversationResponse('Registrei o atendimento para a equipe.', missing).allowed, false);
  assert.equal(validateConversationResponse('Registrei o atendimento para a equipe.', confirmed).allowed, true);
});

test('anti-repetition evita resposta idêntica recente', () => {
  const result = avoidRepeatedResponse('Pagamento ainda pendente.', [
    { direction: 'OUTBOUND', content: 'Pagamento ainda pendente.' }
  ]);
  assert.equal(result.repeated, true);
  assert.notEqual(result.text, 'Pagamento ainda pendente.');
});

test('memória nunca vira source of truth operacional', () => {
  assert.deepEqual(evaluateMemoryCandidate({ type: 'PAYMENT_STATUS' }), {
    action: 'DISCARD', reason: 'AUTHORITATIVE_STATE_NOT_MEMORY'
  });
  assert.deepEqual(evaluateMemoryCandidate({ type: 'PREFERENCE' }), {
    action: 'MEMORY_CANDIDATE', requires_validation: true
  });
});
