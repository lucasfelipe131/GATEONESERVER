import { OPERATIONAL_FAILURE_CLASSES, RENEWAL_STATUSES } from './contracts.js';

export const RENEWAL_TRANSITIONS = Object.freeze({
  REQUESTED: new Set(['WAITING_PAYMENT', 'READY', 'CANCELLED', 'FAILED']),
  WAITING_PAYMENT: new Set(['READY', 'CANCELLED', 'FAILED', 'HUMAN_ACTION_REQUIRED']),
  READY: new Set(['PROCESSING', 'CANCELLED', 'FAILED']),
  PROCESSING: new Set(['VERIFYING', 'RETRY_SCHEDULED', 'HUMAN_ACTION_REQUIRED', 'FAILED']),
  RETRY_SCHEDULED: new Set(['PROCESSING', 'CANCELLED', 'FAILED']),
  VERIFYING: new Set(['COMPLETED', 'RETRY_SCHEDULED', 'HUMAN_ACTION_REQUIRED', 'FAILED']),
  HUMAN_ACTION_REQUIRED: new Set(['PROCESSING', 'VERIFYING', 'CANCELLED', 'FAILED']),
  COMPLETED: new Set(),
  FAILED: new Set(),
  CANCELLED: new Set()
});

export function transitionRenewal(current, next) {
  if (!RENEWAL_STATUSES.includes(current) || !RENEWAL_STATUSES.includes(next)) {
    throw new Error(`Estado de renovação inválido: ${current} -> ${next}`);
  }
  if (current === next) return { changed: false, current, next };
  if (!RENEWAL_TRANSITIONS[current]?.has(next)) {
    throw new Error(`Transição de renovação não permitida: ${current} -> ${next}`);
  }
  return { changed: true, current, next };
}

export function assertRenewalInvariants({
  renewal,
  payment,
  subscription,
  verified = false,
  expectedAmountCents = null
}) {
  if (!renewal || !payment || !subscription) throw new Error('Renovação incompleta.');
  if (renewal.customer_id !== payment.customer_id) throw new Error('PAYMENT_CUSTOMER_MISMATCH');
  if (renewal.customer_id !== subscription.customer_id) throw new Error('CUSTOMER_SUBSCRIPTION_MISMATCH');
  if (renewal.subscription_id !== payment.subscription_id) throw new Error('PAYMENT_SUBSCRIPTION_MISMATCH');
  if (renewal.subscription_id !== subscription.id) throw new Error('RENEWAL_SUBSCRIPTION_MISMATCH');
  if (payment.status !== 'CONFIRMED') throw new Error('PAYMENT_NOT_CONFIRMED');
  if (expectedAmountCents !== null && payment.amount_cents !== expectedAmountCents) {
    throw new Error('PAYMENT_REVIEW_REQUIRED');
  }
  if (renewal.state === 'COMPLETED' && !verified) throw new Error('VERIFICATION_REQUIRED');
  return true;
}

export function expirationForPlan(previousExpiration, { durationMonths }) {
  if (!Number.isInteger(durationMonths) || durationMonths <= 0) {
    throw new Error('Plano requer duração mensal positiva.');
  }
  const input = /^\d{4}-\d{2}-\d{2}$/.test(String(previousExpiration))
    ? `${previousExpiration}T12:00:00.000Z`
    : previousExpiration;
  const date = new Date(input);
  if (!Number.isFinite(date.getTime())) throw new Error('Validade anterior inválida.');
  const day = date.getUTCDate();
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + durationMonths, 1, 12));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0, 12)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

export function classifyOperationalFailure(error) {
  const code = String(error?.code || error?.message || '').toUpperCase();
  let failureClass = 'UNKNOWN';
  if (/TIMEOUT|ECONNRESET|TEMPORARY|UNAVAILABLE/.test(code)) failureClass = 'TRANSIENT';
  else if (/AUTH|SESSION_EXPIRED/.test(code)) failureClass = 'AUTHENTICATION';
  else if (/CAPTCHA|HUMAN_ACTION/.test(code)) failureClass = 'HUMAN_REQUIRED';
  else if (/MISMATCH|PAYMENT_|BUSINESS|INVALID/.test(code)) failureClass = 'BUSINESS_RULE';
  else if (/NOT_FOUND|PERMANENT/.test(code)) failureClass = 'PERMANENT';
  if (!OPERATIONAL_FAILURE_CLASSES.includes(failureClass)) throw new Error('Classe de falha inválida.');
  return {
    class: failureClass,
    retryable: failureClass === 'TRANSIENT',
    human_required: ['AUTHENTICATION', 'HUMAN_REQUIRED'].includes(failureClass)
  };
}

export function retryAt({ attempt, now = new Date(), baseDelayMs = 60_000, maxAttempts = 5 }) {
  if (attempt >= maxAttempts) return null;
  return new Date(now.getTime() + baseDelayMs * (2 ** Math.max(0, attempt - 1))).toISOString();
}
