import assert from 'node:assert/strict';
import test from 'node:test';
import { createCustomerContextSnapshot } from '../src/services/customer-context.js';

const CUSTOMER_A = '10000000-0000-4000-8000-000000000001';
const CUSTOMER_B = '20000000-0000-4000-8000-000000000002';
const CUSTOMER_C = '30000000-0000-4000-8000-000000000003';
const SUB_A = '40000000-0000-4000-8000-000000000004';
const SUB_B = '50000000-0000-4000-8000-000000000005';
const PLAN = '60000000-0000-4000-8000-000000000006';
const PAY_PENDING = '70000000-0000-4000-8000-000000000007';
const PAY_CONFIRMED = '80000000-0000-4000-8000-000000000008';
const RENEWAL = '90000000-0000-4000-8000-000000000009';
const SUPPORT = 'a0000000-0000-4000-8000-00000000000a';
const CONVERSATION_A = 'b0000000-0000-4000-8000-00000000000b';
const CONVERSATION_B = 'c0000000-0000-4000-8000-00000000000c';
const MESSAGE_A = 'd0000000-0000-4000-8000-00000000000d';
const MEMORY_A = 'e0000000-0000-4000-8000-00000000000e';
const CORRELATION_A = 'f0000000-0000-4000-8000-00000000000f';
const CORRELATION_B = '11000000-0000-4000-8000-000000000011';
const NOW = new Date('2026-08-22T12:00:00.000Z');
const OBSERVED = '2026-08-22T10:00:00.000Z';

function contextDb({ customerAPayments = null } = {}) {
  const customers = {
    [CUSTOMER_A]: {
      id: CUSTOMER_A, name: 'João Cliente', whatsapp_e164: '5555999991111',
      status: 'active', lifecycle_status: 'ACTIVE', operational_stage: 'ready',
      name_confirmed_at: OBSERVED, created_at: OBSERVED, updated_at: OBSERVED
    },
    [CUSTOMER_B]: {
      id: CUSTOMER_B, name: 'Maria Cliente', whatsapp_e164: '5555999992222',
      status: 'late', lifecycle_status: null, operational_stage: 'ready',
      name_confirmed_at: OBSERVED, created_at: OBSERVED, updated_at: OBSERVED
    },
    [CUSTOMER_C]: {
      id: CUSTOMER_C, name: 'Cliente Sem Plano', whatsapp_e164: '5555999993333',
      status: 'active', lifecycle_status: 'ACTIVE', operational_stage: 'ready',
      name_confirmed_at: null, created_at: OBSERVED, updated_at: OBSERVED
    }
  };
  const identities = {
    [CUSTOMER_A]: [
      {
        id: '12000000-0000-4000-8000-000000000012', identity_type: 'WHATSAPP',
        provider: 'whatsapp', normalized_value: '5555999991111', verified_at: OBSERVED,
        created_at: OBSERVED, updated_at: OBSERVED
      },
      {
        id: '13000000-0000-4000-8000-000000000013', identity_type: 'LOGIN',
        provider: 'bitpanel', normalized_value: 'joao01', verified_at: OBSERVED,
        created_at: OBSERVED, updated_at: OBSERVED
      }
    ],
    [CUSTOMER_B]: [],
    [CUSTOMER_C]: []
  };
  const subscriptions = {
    [CUSTOMER_A]: [{
      id: SUB_A, status: 'active', starts_on: '2026-08-01', expires_on: '2026-09-22',
      provider: 'bitpanel', provider_reference: 'internal-login', renewal_policy: null,
      created_at: OBSERVED, updated_at: OBSERVED, plan_id: PLAN, plan_code: 'monthly',
      plan_name: 'Mensal', price_cents: 3000
    }],
    [CUSTOMER_B]: [{
      id: SUB_B, status: 'late', starts_on: '2026-07-01', expires_on: '2026-08-01',
      provider: 'bitpanel', provider_reference: 'maria01', renewal_policy: null,
      created_at: OBSERVED, updated_at: OBSERVED, plan_id: PLAN, plan_code: 'monthly',
      plan_name: 'Mensal', price_cents: 3000
    }],
    [CUSTOMER_C]: []
  };
  const payments = {
    [CUSTOMER_A]: customerAPayments || [
      {
        id: PAY_PENDING, subscription_id: SUB_A, charge_id: null, provider: 'mercadopago',
        amount_cents: 3000, currency: 'BRL', status: 'PENDING', correlation_id: CORRELATION_A,
        confirmed_at: null, created_at: OBSERVED, updated_at: OBSERVED
      },
      {
        id: PAY_CONFIRMED, subscription_id: SUB_A, charge_id: null, provider: 'mercadopago',
        amount_cents: 3000, currency: 'BRL', status: 'CONFIRMED', correlation_id: CORRELATION_A,
        confirmed_at: OBSERVED, created_at: '2026-07-20T10:00:00.000Z', updated_at: OBSERVED
      }
    ],
    [CUSTOMER_B]: [],
    [CUSTOMER_C]: []
  };
  const charges = { [CUSTOMER_A]: [], [CUSTOMER_B]: [], [CUSTOMER_C]: [] };
  const renewals = {
    [CUSTOMER_A]: [{
      id: RENEWAL, subscription_id: SUB_A, payment_id: PAY_PENDING,
      core_status: 'WAITING_PAYMENT', legacy_status: 'awaiting_approval',
      previous_expiration: '2026-09-22', requested_extension_months: 1,
      completed_at: null, failure_reason: null, correlation_id: CORRELATION_A,
      created_at: OBSERVED, updated_at: OBSERVED
    }],
    [CUSTOMER_B]: [],
    [CUSTOMER_C]: []
  };
  const conversations = {
    [CUSTOMER_A]: [{
      conversation_id: CONVERSATION_A, customer_id: CUSTOMER_A, channel: 'whatsapp_qr',
      state: 'conversation', context_state: 'GENERAL', data: {}, started_at: OBSERVED,
      last_activity_at: OBSERVED, summary: 'Cliente perguntou sobre renovação.',
      handoff_status: 'NONE', correlation_id: CORRELATION_A,
      pending_actions: [], revision: 2, updated_at: OBSERVED
    }],
    [CUSTOMER_B]: [{
      conversation_id: CONVERSATION_B, customer_id: CUSTOMER_B, channel: 'whatsapp_qr',
      state: 'support', context_state: 'SUPPORT', data: {}, started_at: OBSERVED,
      last_activity_at: OBSERVED, summary: null, handoff_status: 'REQUESTED',
      correlation_id: CORRELATION_B, pending_actions: [], revision: 1, updated_at: OBSERVED
    }],
    [CUSTOMER_C]: []
  };
  const messages = {
    [CUSTOMER_A]: [{
      id: MESSAGE_A, conversation_id: CONVERSATION_A, direction: 'inbound',
      content_type: 'TEXT', content: 'Quero renovar. Senha: abc123', provider_id: 'wa-1', status: 'received',
      processing_status: 'RECEIVED', correlation_id: CORRELATION_A, created_at: OBSERVED
    }],
    [CUSTOMER_B]: [],
    [CUSTOMER_C]: []
  };
  const support = {
    [CUSTOMER_A]: [{
      id: SUPPORT, category: 'buffering', summary: 'travamentos', status: 'open',
      occurrences: 2, correlation_id: CORRELATION_A, first_reported_at: OBSERVED,
      last_mentioned_at: OBSERVED, resolved_at: null, updated_at: OBSERVED
    }],
    [CUSTOMER_B]: [],
    [CUSTOMER_C]: []
  };
  const memories = {
    [CUSTOMER_A]: [{
      memory_id: MEMORY_A, customer_id: CUSTOMER_A, memory_type: 'PREFERENCE',
      memory_key: 'contact-period', value: { period: 'morning' }, source: 'customer_message',
      source_reference: MESSAGE_A, confidence: 'MEDIUM', observed_at: OBSERVED,
      valid_from: null, valid_until: null, superseded_by: null, status: 'ACTIVE',
      created_at: OBSERVED
    }],
    [CUSTOMER_B]: [],
    [CUSTOMER_C]: []
  };
  const provisioning = { [CUSTOMER_A]: [], [CUSTOMER_B]: [], [CUSTOMER_C]: [] };
  const snapshots = [];
  const queryCustomers = [];
  return {
    state: { snapshots, queryCustomers },
    async query(sql, params = []) {
      const text = String(sql);
      const customerId = params[0];
      if (text.includes('FROM customers WHERE id = $1')) {
        return { rows: customers[customerId] ? [customers[customerId]] : [] };
      }
      if (text.includes('FROM customer_identities')) {
        queryCustomers.push(customerId); return { rows: identities[customerId] || [] };
      }
      if (text.includes('FROM subscriptions s') && text.includes('JOIN plans')) {
        queryCustomers.push(customerId); return { rows: subscriptions[customerId] || [] };
      }
      if (text.includes('FROM payments')) {
        queryCustomers.push(customerId); return { rows: payments[customerId] || [] };
      }
      if (text.includes('FROM charges ch')) {
        queryCustomers.push(customerId); return { rows: charges[customerId] || [] };
      }
      if (text.includes('FROM renewal_jobs r')) {
        queryCustomers.push(customerId); return { rows: renewals[customerId] || [] };
      }
      if (text.includes('FROM conversation_sessions')) {
        queryCustomers.push(customerId); return { rows: conversations[customerId] || [] };
      }
      if (text.includes('FROM message_logs')) {
        queryCustomers.push(customerId); return { rows: (messages[customerId] || []).slice(0, params[1]) };
      }
      if (text.includes('FROM customer_issues')) {
        queryCustomers.push(customerId); return { rows: support[customerId] || [] };
      }
      if (text.includes('FROM customer_memories')) {
        queryCustomers.push(customerId); return { rows: memories[customerId] || [] };
      }
      if (text.includes('FROM provisioning_operations')) {
        queryCustomers.push(customerId); return { rows: provisioning[customerId] || [] };
      }
      if (text.startsWith('INSERT INTO customer_context_snapshots')) {
        snapshots.push({ customerId: params[1], correlationId: params[2], context: JSON.parse(params[8]) });
        return { rows: [] };
      }
      throw new Error(`SQL inesperado: ${text}`);
    }
  };
}

function create(db, customerId, purpose, correlationId, overrides = {}) {
  return createCustomerContextSnapshot(db, {
    customerId,
    purpose,
    channel: 'WHATSAPP',
    correlationId,
    now: NOW,
    ...overrides
  });
}

test('Customer 360 compõe cliente ativo, múltiplas fontes e minimiza identity no WhatsApp', async () => {
  const db = contextDb();
  const snapshot = await create(db, CUSTOMER_A, 'CONVERSATION', CORRELATION_A);
  const context = snapshot.customer360;
  assert.equal(context.lifecycle.state.value, 'ACTIVE');
  assert.equal(context.subscription.plan_name.value, 'Mensal');
  assert.equal(context.identity.identities.length, 1);
  assert.equal(context.identity.identities[0].type, 'WHATSAPP');
  assert.equal(
    context.conversation.recent_messages[0].content,
    'Quero renovar. Senha: [REDACTED]'
  );
  assert.equal(context.support.open_cases[0].support_case_id, SUPPORT);
  assert.equal(context.memories[0].value.period, 'morning');
  assert.ok(context.pending_actions.some((item) => item.type === 'PAYMENT'));
  assert.ok(context.pending_actions.some((item) => item.type === 'RENEWAL'));
  assert.equal(snapshot.correlation_id, CORRELATION_A);
  assert.equal(db.state.snapshots.length, 1);
});

test('cliente vencido usa lifecycle legado sem inferir estado financeiro', async () => {
  const db = contextDb();
  const snapshot = await create(db, CUSTOMER_B, 'CONVERSATION', CORRELATION_B);
  assert.equal(snapshot.customer360.lifecycle.state.value, 'PAST_DUE');
  assert.equal(snapshot.customer360.subscription.status.value, 'LATE');
  assert.equal(Object.hasOwn(snapshot.customer360, 'financial'), false);
});

test('cliente sem assinatura produz contexto parcial e dado ausente explícito', async () => {
  const db = contextDb();
  const snapshot = await create(db, CUSTOMER_C, 'PAYMENT', CORRELATION_A);
  assert.equal(snapshot.customer360.context_status, 'PARTIAL');
  assert.equal(snapshot.customer360.subscription, null);
  assert.ok(snapshot.customer360.missing_fields.includes('subscription'));
  assert.equal(snapshot.customer360.identity.name, null);
  assert.ok(snapshot.customer360.missing_fields.includes('identity.name'));
  assert.ok(snapshot.exclusion_reason_codes.includes('UNCONFIRMED_IDENTITY'));
  assert.equal(snapshot.customer360.financial.last_payment, null);
  assert.equal(snapshot.customer360.financial.pending_payment, null);
});

test('finalidade PAYMENT distingue pendente, confirmado e renovação pendente', async () => {
  const db = contextDb();
  const snapshot = await create(db, CUSTOMER_A, 'PAYMENT', CORRELATION_A);
  assert.equal(snapshot.customer360.financial.pending_payment.status, 'PENDING');
  assert.equal(snapshot.customer360.financial.confirmed_payment, null);
  assert.equal(snapshot.customer360.financial.last_payment.status, 'PENDING');
  assert.equal(snapshot.customer360.renewal.status, 'WAITING_PAYMENT');
});

test('pagamento confirmado só é atual quando é o registro mais recente', async () => {
  const db = contextDb({
    customerAPayments: [{
      id: PAY_CONFIRMED,
      subscription_id: SUB_A,
      charge_id: null,
      provider: 'mercadopago',
      amount_cents: 3000,
      currency: 'BRL',
      status: 'CONFIRMED',
      correlation_id: CORRELATION_A,
      confirmed_at: OBSERVED,
      created_at: OBSERVED,
      updated_at: OBSERVED
    }]
  });
  const snapshot = await create(db, CUSTOMER_A, 'PAYMENT', CORRELATION_A);
  assert.equal(snapshot.customer360.financial.pending_payment, null);
  assert.equal(snapshot.customer360.financial.confirmed_payment.status, 'CONFIRMED');
});

test('finalidade SUPPORT seleciona atendimento aberto sem expor dados financeiros', async () => {
  const db = contextDb();
  const snapshot = await create(db, CUSTOMER_A, 'SUPPORT', CORRELATION_A);
  assert.equal(snapshot.customer360.support.open_cases.length, 1);
  assert.equal(Object.hasOwn(snapshot.customer360, 'financial'), false);
  assert.ok(snapshot.customer360.selected_scopes.includes('SUPPORT'));
});

test('cliente inexistente retorna erro explícito', async () => {
  const db = contextDb();
  await assert.rejects(
    create(db, '99000000-0000-4000-8000-000000000099', 'CONVERSATION', CORRELATION_A),
    (error) => error.code === 'CUSTOMER_NOT_FOUND'
  );
});

test('snapshots concorrentes não cruzam customers, mensagens ou referências', async () => {
  const db = contextDb();
  const [a, b] = await Promise.all([
    create(db, CUSTOMER_A, 'CONVERSATION', CORRELATION_A),
    create(db, CUSTOMER_B, 'CONVERSATION', CORRELATION_B)
  ]);
  assert.equal(a.customer_id, CUSTOMER_A);
  assert.equal(b.customer_id, CUSTOMER_B);
  assert.notEqual(a.context_snapshot_id, b.context_snapshot_id);
  assert.equal(a.customer360.conversation.recent_messages[0].message_id, MESSAGE_A);
  assert.equal(b.customer360.conversation.recent_messages.length, 0);
  assert.equal(a.sources.some((source) => source.source_id === CONVERSATION_B), false);
  assert.equal(b.sources.some((source) => source.source_id === CONVERSATION_A), false);
  assert.ok(db.state.queryCustomers.every((id) => [CUSTOMER_A, CUSTOMER_B].includes(id)));
  assert.deepEqual(new Set(db.state.snapshots.map((item) => item.customerId)), new Set([CUSTOMER_A, CUSTOMER_B]));
});
