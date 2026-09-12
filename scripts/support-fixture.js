import { randomUUID } from 'node:crypto';
import { InMemorySupportRepository } from '../src/services/support-repository.js';
import { SupportOperations } from '../src/services/support-operations.js';
import { SupportAgent } from '../src/services/support-agent.js';
import { GateConversationAgent } from '../src/services/conversation-agent.js';
import { InMemoryConversationAgentRepository } from '../src/services/conversation-operations.js';
import { ConversationToolRegistry } from '../src/services/conversation-tools.js';

export const env = {
  SUPPORT_AGENT_ENABLED: 'true',
  GATE_ENVIRONMENT: 'test',
  PROVIDER_MODE: 'fake-only',
  NODE_ENV: 'test',
};
export async function fixture({
  known = true,
  fail = false,
  unverifiable = false,
  repository = new InMemorySupportRepository(),
  customers = [randomUUID(), randomUUID()],
  contextLoader = null,
} = {}) {
  const operations = new SupportOperations({ repository, env });
  const [a, b] = customers;
  for (const customer_id of [a, b])
    if (known)
      await repository.put('probes', {
        id: randomUUID(),
        customer_id,
        synthetic: true,
        problem_code: 'STALE_SESSION',
        healthy: false,
        fail_action: fail,
        unverifiable,
        updated_at: new Date().toISOString(),
      });
  const knowledge_id = randomUUID();
  await repository.put('knowledge', {
    id: knowledge_id,
    customer_id: null,
    problem_pattern: 'STALE_SESSION',
    solution: 'REFRESH_SYNTHETIC_SESSION',
    validation_status: 'VALIDATED',
    confidence: 0.99,
    source: 'TEST_CURATOR',
    created_at: new Date().toISOString(),
    last_validated_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  const context =
    contextLoader ||
    (async (customer_id) => ({
      contract: 'Customer360.v1',
      customer_id,
      context_status: 'COMPLETE',
      identity: {
        name: {
          value:
            customer_id === a ? 'Cliente A sintético' : 'Cliente B sintético',
        },
      },
      subscription: {
        status: { value: 'ACTIVE' },
        expires_at: { value: '2030-01-01' },
      },
      support: {
        recent_cases: await repository.list('cases', { customer_id }),
        exceptions: await repository.list('exceptions', { customer_id }),
      },
      conversation: { state: 'SUPPORT', recent_messages: [] },
    }));
  const decisions = new InMemoryConversationAgentRepository();
  const registry = new ConversationToolRegistry({
    maxToolCalls: 12,
    handlers: {
      ...operations.handlers(),
      resolveCustomer: async (i) => ({
        status: 'MATCHED',
        customer_id: i.value,
      }),
      getCustomerContext: async (i) => ({
        contract: 'ContextSnapshot.v1',
        customer_id: i.customer_id,
        context_snapshot_id: randomUUID(),
        customer360: await context(i.customer_id),
      }),
      getSubscription: async (i) => ({
        customer_id: i.customer_id,
        status: 'ACTIVE',
        expires_at: '2030-01-01',
      }),
      getPaymentStatus: async (i) => ({
        customer_id: i.customer_id,
        status: 'NOT_FOUND',
      }),
      getRenewalStatus: async (i) => ({
        customer_id: i.customer_id,
        status: 'NOT_FOUND',
      }),
      requestHumanHandoff: (i) => decisions.requestHandoff(i),
    },
  });
  const agent = new GateConversationAgent({
    repository: decisions,
    registry,
    supportAgent: new SupportAgent(),
  });
  const conversationIds = new Map(customers.map((id) => [id, randomUUID()]));
  const run = (
    text = 'não está funcionando',
    customer = a,
    messageId = randomUUID(),
  ) =>
    agent.process({
      conversationId: conversationIds.get(customer) || randomUUID(),
      messageId,
      text,
      identity: { type: 'WHATSAPP', provider: 'fake', value: customer },
      correlationId: randomUUID(),
    });
  return {
    repository,
    operations,
    a,
    b,
    context,
    registry,
    agent,
    run,
    decisions,
    knowledge_id,
    conversationIds,
  };
}
