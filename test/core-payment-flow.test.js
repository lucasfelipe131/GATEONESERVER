import assert from 'node:assert/strict';
import test from 'node:test';
import { markPaymentApproved } from '../src/services/billing.js';

const CHARGE_ID = '10000000-0000-4000-8000-000000000001';
const CUSTOMER_ID = '20000000-0000-4000-8000-000000000002';
const SUBSCRIPTION_ID = '30000000-0000-4000-8000-000000000003';
const PAYMENT_ID = '40000000-0000-4000-8000-000000000004';
const RENEWAL_ID = '50000000-0000-4000-8000-000000000005';
const CORRELATION_ID = '60000000-0000-4000-8000-000000000006';

function paymentDb() {
  const state = {
    chargeStatus: 'sent',
    paymentInserts: 0,
    renewalInserts: 0,
    outboxEvents: []
  };
  const client = {
    async query(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      if (normalized.startsWith('SELECT ch.*, s.customer_id')) {
        return {
          rows: [{
            id: CHARGE_ID,
            status: state.chargeStatus,
            customer_id: CUSTOMER_ID,
            subscription_id: SUBSCRIPTION_ID,
            bitpanel_list_id: 'list-1',
            duration_months: 1,
            amount_cents: 3000,
            stage: 'manual',
            correlation_id: CORRELATION_ID
          }]
        };
      }
      if (normalized.startsWith('SELECT r.id, r.payment_id')) {
        return { rows: [{ id: RENEWAL_ID, payment_id: PAYMENT_ID }] };
      }
      if (normalized.startsWith('INSERT INTO payments')) {
        state.paymentInserts += 1;
        return { rowCount: 1, rows: [{ id: PAYMENT_ID }] };
      }
      if (normalized.startsWith('INSERT INTO gate_event_outbox')) {
        state.outboxEvents.push({ eventType: params[1], correlationId: params[4] });
        return { rowCount: 1, rows: [{ event_id: params[0] }] };
      }
      if (normalized.startsWith('UPDATE charges')) {
        state.chargeStatus = 'paid';
        return { rows: [{ id: CHARGE_ID, status: 'paid' }] };
      }
      if (normalized.startsWith('INSERT INTO renewal_jobs')) {
        state.renewalInserts += 1;
        return { rows: [{ id: RENEWAL_ID }] };
      }
      if (normalized.startsWith('UPDATE leads') || normalized.startsWith('UPDATE customers')) {
        return { rows: [] };
      }
      throw new Error(`SQL inesperado: ${normalized}`);
    }
  };
  return {
    state,
    async transaction(callback) { return callback(client); }
  };
}

test('pagamento duplicado não cria outro payment, renewal ou evento', async () => {
  const db = paymentDb();
  const payment = { id: 'mp-payment-123', status: 'approved' };
  const first = await markPaymentApproved(db, CHARGE_ID, payment);
  const duplicate = await markPaymentApproved(db, CHARGE_ID, payment);

  assert.equal(first.duplicate, false);
  assert.equal(first.paymentId, PAYMENT_ID);
  assert.equal(first.renewalId, RENEWAL_ID);
  assert.equal(duplicate.duplicate, true);
  assert.equal(db.state.paymentInserts, 1);
  assert.equal(db.state.renewalInserts, 1);
  assert.deepEqual(db.state.outboxEvents.map((item) => item.eventType), [
    'payment.confirmed',
    'renewal.ready'
  ]);
  assert.ok(db.state.outboxEvents.every((item) => item.correlationId === CORRELATION_ID));
});
