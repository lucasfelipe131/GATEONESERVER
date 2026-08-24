import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { InMemoryConversationAgentRepository } from '../src/services/conversation-operations.js';

test('conversation lock serializa turnos e exige token do claimant', async () => {
  const repository = new InMemoryConversationAgentRepository();
  const first = await repository.claimTurn({ conversationKey: 'wa:1', messageId: 'm1' });
  const concurrent = await repository.claimTurn({ conversationKey: 'wa:1', messageId: 'm2' });
  assert.equal(first.acquired, true);
  assert.equal(concurrent.acquired, false);
  assert.equal(await repository.releaseTurn('wa:1', 'token-incorreto'), false);
  assert.equal(await repository.releaseTurn('wa:1', first.token), true);
  assert.equal((await repository.claimTurn({ conversationKey: 'wa:1', messageId: 'm2' })).acquired, true);
});

test('claim PostgreSQL usa lease persistente e compare-and-set temporal', async () => {
  const [repository, migration] = await Promise.all([
    readFile(new URL('../src/services/conversation-operations.js', import.meta.url), 'utf8'),
    readFile(new URL('../database/migrations/0005_whatsapp_autonomous_operations.sql', import.meta.url), 'utf8')
  ]);
  assert.match(repository, /ON CONFLICT \(conversation_key\) DO UPDATE/);
  assert.match(repository, /conversation_turn_leases\.claim_until < now\(\)/);
  assert.match(repository, /DELETE FROM conversation_turn_leases WHERE conversation_key = \$1 AND claim_token = \$2/);
  assert.match(migration, /conversation_key text PRIMARY KEY/);
  assert.match(migration, /claim_token uuid NOT NULL/);
});

test('decision audit registra operação, não chain-of-thought', async () => {
  const [repository, migration] = await Promise.all([
    readFile(new URL('../src/services/conversation-operations.js', import.meta.url), 'utf8'),
    readFile(new URL('../database/migrations/0005_whatsapp_autonomous_operations.sql', import.meta.url), 'utf8')
  ]);
  const source = `${repository}\n${migration}`;
  for (const field of ['intents', 'confidence', 'proposed_action', 'policy_result', 'response_facts', 'outcome']) {
    assert.match(source, new RegExp(field));
  }
  assert.doesNotMatch(source, /chain_of_thought|hidden_reasoning|internal_reasoning/i);
});

test('handoff idempotente preserva contexto sem duplicar registro', async () => {
  const repository = new InMemoryConversationAgentRepository();
  const input = {
    conversation_id: 'wa:1', customer_id: null,
    context_snapshot_id: null, correlation_id: '10000000-0000-4000-8000-000000000001',
    reason: 'HUMAN_REQUEST', intent: { primary_intent: 'HUMAN_REQUEST' },
    tools_used: [], summary: 'Solicitação humana.', idempotency_key: 'handoff:1'
  };
  const first = await repository.requestHandoff(input);
  const duplicate = await repository.requestHandoff(input);
  assert.equal(first.handoff_id, duplicate.handoff_id);
  assert.equal(duplicate.duplicate, true);
  assert.equal(repository.handoffs.size, 1);
});
