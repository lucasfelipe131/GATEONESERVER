import { createHash } from 'node:crypto';

function stableKey(namespace, parts) {
  const normalized = parts.map((part) => String(part || '').trim()).join('|');
  if (parts.some((part) => !String(part || '').trim())) {
    throw new Error(`Chave idempotente ${namespace} possui componente vazio.`);
  }
  return `${namespace}:${createHash('sha256').update(normalized).digest('hex')}`;
}

export function paymentIdempotencyKey(provider, externalPaymentId) {
  return stableKey('payment', [String(provider).toLowerCase(), externalPaymentId]);
}

export function renewalIdempotencyKey(customerId, subscriptionId, paymentId) {
  return stableKey('renewal', [customerId, subscriptionId, paymentId]);
}

export function provisioningIdempotencyKey(provider, operation, renewalId) {
  return stableKey('provisioning', [String(provider).toLowerCase(), operation, renewalId]);
}
