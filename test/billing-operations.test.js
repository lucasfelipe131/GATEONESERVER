import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PaymentProvider,
  isTrustedPaymentConfirmation,
  normalizeProviderPayment,
  reconcilePayment
} from '../src/core/billing-operations.js';

const internal = {
  customer_id: 'customer-a', subscription_id: 'subscription-a', status: 'PENDING',
  amount_cents: 3000, currency: 'BRL'
};

function external(overrides = {}) {
  return normalizeProviderPayment({
    provider: 'fake', externalPaymentId: 'payment-1', externalEventId: 'event-1',
    status: 'pending', amountCents: 3000, currency: 'BRL',
    customerId: 'customer-a', subscriptionId: 'subscription-a',
    observedAt: '2026-08-23T12:00:00.000Z', ...overrides
  });
}

test('PaymentProvider exige adapter e operações explícitas', () => {
  assert.throws(() => new PaymentProvider('fake'), /contrato abstrato/);
  class Fake extends PaymentProvider {}
  const provider = new Fake('fake');
  assert.throws(() => provider.createPayment(), /não implementado/);
  assert.throws(() => provider.verifyPayment(), /não implementado/);
});

test('normaliza created, pending, confirmed, failed, expired e refund', () => {
  assert.equal(external({ status: 'created' }).status, 'CREATED');
  assert.equal(external({ status: 'pending' }).status, 'PENDING');
  assert.equal(external({ status: 'approved' }).status, 'CONFIRMED');
  assert.equal(external({ status: 'rejected' }).status, 'FAILED');
  assert.equal(external({ status: 'expired' }).status, 'EXPIRED');
  assert.equal(external({ status: 'refunded' }).status, 'REFUNDED');
});

test('reconciliação detecta match e provider à frente', () => {
  assert.deepEqual(reconcilePayment({ internal, external: external() }), {
    status: 'MATCHED', reason: null
  });
  assert.deepEqual(reconcilePayment({
    internal, external: external({ status: 'approved' })
  }), { status: 'INTERNAL_STALE', reason: 'PROVIDER_AHEAD' });
});

test('valor divergente exige revisão e não cria crédito ou extensão', () => {
  assert.deepEqual(reconcilePayment({
    internal, external: external({ amountCents: 1000 })
  }), { status: 'DIVERGENT', reason: 'AMOUNT_OR_CURRENCY_MISMATCH' });
  assert.deepEqual(reconcilePayment({
    internal, external: external({ amountCents: 5000 })
  }), { status: 'DIVERGENT', reason: 'AMOUNT_OR_CURRENCY_MISMATCH' });
});

test('pagamento de outro cliente ou assinatura sempre requer revisão', () => {
  assert.equal(reconcilePayment({
    internal, external: external({ customerId: 'customer-b' })
  }).reason, 'CUSTOMER_MISMATCH');
  assert.equal(reconcilePayment({
    internal, external: external({ subscriptionId: 'subscription-b' })
  }).reason, 'SUBSCRIPTION_MISMATCH');
});

test('mensagem ou comprovante do cliente não confirma pagamento', () => {
  assert.equal(isTrustedPaymentConfirmation({ source: 'CUSTOMER_MESSAGE' }), false);
  assert.equal(isTrustedPaymentConfirmation({ source: 'PROVIDER', providerVerified: false }), false);
  assert.equal(isTrustedPaymentConfirmation({ source: 'PROVIDER', providerVerified: true }), true);
  assert.equal(isTrustedPaymentConfirmation({
    source: 'ADMIN', administrativeActor: { id: 'admin-1', capability: 'billing:manage' }
  }), true);
});
