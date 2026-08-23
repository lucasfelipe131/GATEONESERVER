import {
  PAYMENT_RECONCILIATION_STATUSES,
  PAYMENT_STATUSES
} from './contracts.js';

export const PROVIDER_PAYMENT_STATUSES = Object.freeze({
  created: 'CREATED',
  pending: 'PENDING',
  approved: 'CONFIRMED',
  confirmed: 'CONFIRMED',
  failed: 'FAILED',
  rejected: 'FAILED',
  expired: 'EXPIRED',
  cancelled: 'CANCELLED',
  canceled: 'CANCELLED',
  refunded: 'REFUNDED'
});

export class PaymentProvider {
  constructor(providerName) {
    if (new.target === PaymentProvider) {
      throw new Error('PaymentProvider é um contrato abstrato.');
    }
    this.providerName = String(providerName || '').trim().toLowerCase();
    if (!this.providerName) throw new Error('PaymentProvider requer providerName.');
  }

  createPayment() { throw new Error('createPayment() não implementado.'); }
  getPayment() { throw new Error('getPayment() não implementado.'); }
  cancelPayment() { throw new Error('cancelPayment() não implementado.'); }
  parseWebhook() { throw new Error('parseWebhook() não implementado.'); }
  verifyPayment() { throw new Error('verifyPayment() não implementado.'); }
  getExternalStatus() { throw new Error('getExternalStatus() não implementado.'); }
}

export function normalizeProviderPayment({
  provider,
  externalPaymentId,
  externalEventId,
  status,
  amountCents,
  currency = 'BRL',
  observedAt = new Date().toISOString(),
  customerId = null,
  subscriptionId = null,
  payload = null
}) {
  const normalizedStatus = PAYMENT_STATUSES.includes(String(status).toUpperCase())
    ? String(status).toUpperCase()
    : PROVIDER_PAYMENT_STATUSES[String(status || '').toLowerCase()];
  if (!normalizedStatus) throw new Error(`Status financeiro externo não suportado: ${status}`);
  if (!provider || !externalPaymentId || !externalEventId) {
    throw new Error('Evento financeiro requer provider, payment ID e event ID externos.');
  }
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new Error('Evento financeiro requer amountCents inteiro e positivo.');
  }
  return Object.freeze({
    provider: String(provider).trim().toLowerCase(),
    external_payment_id: String(externalPaymentId),
    external_event_id: String(externalEventId),
    status: normalizedStatus,
    amount_cents: amountCents,
    currency: String(currency).toUpperCase(),
    observed_at: new Date(observedAt).toISOString(),
    customer_id: customerId,
    subscription_id: subscriptionId,
    payload
  });
}

export function reconcilePayment({ internal, external }) {
  if (!internal || !external) throw new Error('Reconciliação requer estados interno e externo.');
  if (external.customer_id && external.customer_id !== internal.customer_id) {
    return { status: 'REQUIRES_REVIEW', reason: 'CUSTOMER_MISMATCH' };
  }
  if (external.subscription_id && external.subscription_id !== internal.subscription_id) {
    return { status: 'REQUIRES_REVIEW', reason: 'SUBSCRIPTION_MISMATCH' };
  }
  if (external.currency !== internal.currency || external.amount_cents !== internal.amount_cents) {
    return { status: 'DIVERGENT', reason: 'AMOUNT_OR_CURRENCY_MISMATCH' };
  }
  if (external.status === internal.status) return { status: 'MATCHED', reason: null };
  const terminal = new Set(['CONFIRMED', 'FAILED', 'EXPIRED', 'CANCELLED', 'REFUNDED']);
  if (!terminal.has(internal.status) && terminal.has(external.status)) {
    return { status: 'INTERNAL_STALE', reason: 'PROVIDER_AHEAD' };
  }
  if (terminal.has(internal.status) && !terminal.has(external.status)) {
    return { status: 'EXTERNAL_STALE', reason: 'GATE_AHEAD' };
  }
  return { status: 'DIVERGENT', reason: 'STATE_MISMATCH' };
}

export function assertReconciliationStatus(status) {
  if (!PAYMENT_RECONCILIATION_STATUSES.includes(status)) {
    throw new Error(`Estado de reconciliação inválido: ${status}`);
  }
  return status;
}

export function isTrustedPaymentConfirmation({ source, providerVerified, administrativeActor }) {
  if (source === 'PROVIDER') return providerVerified === true;
  if (source === 'ADMIN') return Boolean(administrativeActor?.id && administrativeActor?.capability);
  return false;
}
