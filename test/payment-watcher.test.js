import assert from 'node:assert/strict';
import test from 'node:test';
import { PaymentWatcher } from '../src/services/payment-watcher.js';

const IDS = {
  payment: '10000000-0000-4000-8000-000000000001',
  customer: '20000000-0000-4000-8000-000000000002',
  subscription: '30000000-0000-4000-8000-000000000003',
  correlation: '40000000-0000-4000-8000-000000000004'
};

function watcherDb() {
  const state = {
    events: new Set(), paymentStatus: 'PENDING', paymentUpdates: 0, outbox: []
  };
  const client = {
    async query(sql, params = []) {
      const text = String(sql).replace(/\s+/g, ' ').trim();
      if (text.startsWith('INSERT INTO payment_provider_events')) {
        const key = `${params[0]}:${params[1]}`;
        if (state.events.has(key)) return { rowCount: 0, rows: [] };
        state.events.add(key);
        return { rowCount: 1, rows: [{ id: '50000000-0000-4000-8000-000000000005' }] };
      }
      if (text.startsWith('SELECT * FROM payments')) {
        return { rows: [{
          id: IDS.payment, customer_id: IDS.customer, subscription_id: IDS.subscription,
          provider: 'fake', external_payment_id: 'external-payment-1',
          status: state.paymentStatus, amount_cents: 3000, currency: 'BRL'
        }] };
      }
      if (text.startsWith('UPDATE payments')) {
        if (!text.includes("reconciliation_status = 'REQUIRES_REVIEW'")) {
          state.paymentStatus = params[1];
        }
        state.paymentUpdates += 1; return { rowCount: 1, rows: [] };
      }
      if (text.startsWith('UPDATE payment_provider_events')) return { rowCount: 1, rows: [] };
      if (text.startsWith('INSERT INTO gate_event_outbox')) {
        state.outbox.push(params[1]); return { rowCount: 1, rows: [{ event_id: params[0] }] };
      }
      throw new Error(`SQL inesperado: ${text}`);
    }
  };
  return { state, async transaction(callback) { return callback(client); } };
}

function event(overrides = {}) {
  return {
    externalPaymentId: 'external-payment-1', externalEventId: 'external-event-1',
    status: 'approved', amountCents: 3000, currency: 'BRL',
    customerId: IDS.customer, subscriptionId: IDS.subscription,
    observedAt: '2026-08-23T12:00:00.000Z', ...overrides
  };
}

test('webhook duplicado produz uma confirmação e um evento efetivos', async () => {
  const db = watcherDb();
  const watcher = new PaymentWatcher({ db, providerName: 'fake' });
  const first = await watcher.observe(event(), {
    source: 'WEBHOOK', providerVerified: true, correlationId: IDS.correlation
  });
  const duplicate = await watcher.observe(event(), {
    source: 'WEBHOOK', providerVerified: true, correlationId: IDS.correlation
  });
  assert.equal(first.status, 'CONFIRMED');
  assert.deepEqual(duplicate, { duplicate: true, changed: false });
  assert.equal(db.state.paymentUpdates, 1);
  assert.deepEqual(db.state.outbox, ['payment.confirmed']);
});

test('POST não verificado não confirma e segue para revisão', async () => {
  const db = watcherDb();
  const watcher = new PaymentWatcher({ db, providerName: 'fake' });
  const result = await watcher.observe(event(), {
    source: 'WEBHOOK', providerVerified: false, correlationId: IDS.correlation
  });
  assert.equal(result.changed, false);
  assert.equal(result.review, 'UNTRUSTED_CONFIRMATION_SOURCE');
  assert.equal(db.state.paymentStatus, 'PENDING');
  assert.deepEqual(db.state.outbox, ['payment.review_required']);
});
