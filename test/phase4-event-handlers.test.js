import assert from 'node:assert/strict';
import test from 'node:test';
import { createPhase4EventHandlers } from '../src/services/phase4-event-handlers.js';

const IDS = {
  renewal: '10000000-0000-4000-8000-000000000001',
  payment: '20000000-0000-4000-8000-000000000002',
  customer: '30000000-0000-4000-8000-000000000003',
  subscription: '40000000-0000-4000-8000-000000000004',
  event: '50000000-0000-4000-8000-000000000005',
  correlation: '60000000-0000-4000-8000-000000000006'
};

function event(type, overrides = {}) {
  return {
    event_id: IDS.event, event_type: type, correlation_id: IDS.correlation,
    subject: type === 'payment.confirmed'
      ? { type: 'payment', id: IDS.payment }
      : { type: 'renewal', id: IDS.renewal },
    payload: { customer_id: IDS.customer, subscription_id: IDS.subscription },
    ...overrides
  };
}

function fixture(overrides = {}) {
  const row = {
    renewal_id: IDS.renewal, payment_id: IDS.payment, correlation_id: IDS.correlation,
    previous_expiration: '2026-08-31', requested_extension_months: 1,
    customer_id: IDS.customer, subscription_id: IDS.subscription,
    payment_status: 'CONFIRMED', amount_cents: 3000, currency: 'BRL',
    subscription_customer_id: IDS.customer, expected_amount_cents: 3000,
    ...overrides
  };
  const calls = [];
  const renewalOrchestrator = {
    async start(input) { calls.push({ operation: 'start', input }); return { state: 'READY' }; },
    async run(id) { calls.push({ operation: 'run', id }); return { saga: { state: 'COMPLETED' } }; }
  };
  const db = { async query() { return { rows: [row] }; } };
  return { calls, handlers: createPhase4EventHandlers({ db, renewalOrchestrator }) };
}

test('payment.confirmed cria saga e renewal.ready executa pelo mesmo Core', async () => {
  const { handlers, calls } = fixture();
  await handlers['payment.confirmed'](event('payment.confirmed'));
  await handlers['renewal.ready'](event('renewal.ready'));
  assert.deepEqual(calls.map((call) => call.operation), ['start', 'start', 'run']);
  assert.equal(calls[0].input.requestedBy.type, 'SYSTEM');
  assert.equal(calls[0].input.causationId, IDS.event);
});

test('consumer bloqueia evento que tenta cruzar clientes', async () => {
  const { handlers, calls } = fixture();
  await assert.rejects(
    handlers['payment.confirmed'](event('payment.confirmed', {
      payload: { customer_id: 'customer-b', subscription_id: IDS.subscription }
    })),
    /EVENT_CUSTOMER_MISMATCH/
  );
  assert.equal(calls.length, 0);
});
