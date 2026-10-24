const PLAN_MONTHS = Object.freeze({ monthly: 1, quarterly: 3, semiannual: 6, annual: 12 });
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const approvedSources = new Set(['PROVIDER_API', 'PROVIDER_RECONCILIATION', 'RECONCILIATION', 'WEBHOOK']);
const denied = code => ({ allowed: false, requiresApproval: true, code, creditCost: null });
const positiveInteger = value => Number.isSafeInteger(value) && value > 0;
const uuid = value => typeof value === 'string' && UUID.test(value);
const sameId = (left, right) => uuid(left) && uuid(right) && left.toLowerCase() === right.toLowerCase();
const listId = value => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value);
const username = value => typeof value === 'string' && value.length > 0 && value.length <= 120 && value.trim() === value && !/[\r\n\x00]/.test(value);

function date(value) {
  if (!(typeof value === 'string' && value.trim() || value instanceof Date)) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function gateOneOwner(value) {
  if (typeof value !== 'string') return false;
  const normalized = value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return normalized === 'gateoneproserver' || normalized === 'gateoneserver';
}

function validatedSource(value) {
  if (value === undefined) return true;
  if (typeof value !== 'string' || /[\s\\\u0000-\u001f]/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['bitpanel.vip', 'www.bitpanel.vip'].includes(url.hostname) &&
      !url.username && !url.password && !url.search && !url.hash && !url.port;
  } catch { return false; }
}

/**
 * Only trusted policy settings and database rows may enter this boundary.
 * It does not verify an HTTP request or payment screenshot. The caller must
 * claim the job once and compare the provider's live quote before any click.
 */
export function automaticRenewalDecision({ policy, renewal, payment, customer, now = new Date() } = {}) {
  if (policy?.enabled !== true) return denied('AUTO_RENEWAL_DISABLED');
  const current = date(now), activated = date(policy.activatedAt), validated = date(policy.validatedAt);
  if (!current || !activated || !validated || activated > current || validated > current ||
      policy.provider !== 'mercadopago' || policy.operation !== 'renew' || !validatedSource(policy.validatedSource) ||
      !positiveInteger(policy.maxCreditsPerRenewal)) return denied('AUTO_RENEWAL_POLICY_INVALID');
  if (policy.validUntil !== undefined) {
    const until = date(policy.validUntil);
    if (!until || until <= validated || until <= activated) return denied('AUTO_RENEWAL_POLICY_INVALID');
    if (until <= current) return denied('AUTO_RENEWAL_POLICY_EXPIRED');
  }

  if (!renewal || !payment || !customer) return denied('AUTO_RENEWAL_SUBJECT_MISMATCH');
  if (renewal.operation && renewal.operation !== 'renew' || renewal.charge_stage === 'new_sale' ||
      !listId(renewal.bitpanel_list_id) || !username(renewal.bitpanel_reference)) return denied('AUTO_RENEWAL_NOT_RENEWAL');
  if (customer.automation_eligible !== true || renewal.automation_eligible !== true ||
      !gateOneOwner(customer.bitpanel_owner) || !gateOneOwner(renewal.bitpanel_owner)) return denied('AUTO_RENEWAL_CUSTOMER_INELIGIBLE');
  const customerList = customer.bitpanel_list_id ?? customer.list_id;
  const customerUsername = customer.bitpanel_reference ?? customer.username;
  if (!uuid(renewal.id) || !sameId(renewal.customer_id, customer.id) || !sameId(payment.customer_id, customer.id) ||
      !sameId(renewal.subscription_id, customer.subscription_id) || !sameId(payment.subscription_id, renewal.subscription_id) ||
      !sameId(renewal.payment_id, payment.id) || !sameId(renewal.charge_id, payment.charge_id) ||
      customerList !== renewal.bitpanel_list_id || customerUsername !== renewal.bitpanel_reference ||
      customer.subscription_customer_id !== undefined && !sameId(customer.subscription_customer_id, customer.id))
    return denied('AUTO_RENEWAL_SUBJECT_MISMATCH');

  if (renewal.attempts !== 0 || renewal.completed_at || renewal.processing_at || renewal.after_expiry || renewal.duplicate === true)
    return denied('AUTO_RENEWAL_ALREADY_ATTEMPTED');
  if (!['awaiting_approval', 'queued'].includes(renewal.status) || renewal.core_status !== 'READY' || renewal.charge_status !== 'paid')
    return denied('AUTO_RENEWAL_STATE_BLOCKED');

  const confirmed = date(payment.confirmed_at ?? payment.confirmedAt);
  const providerApproved = date(payment.provider_payload?.date_approved);
  if (payment.provider !== 'mercadopago' || payment.status !== 'CONFIRMED' || payment.currency !== 'BRL' ||
      payment.reconciliation_status !== 'MATCHED' || payment.review_reason ||
      !/^\d{1,32}$/.test(String(payment.external_payment_id || '')) || !confirmed || confirmed > current ||
      !providerApproved || providerApproved > current ||
      payment.simulated === true || payment.live_mode === false || payment.provider_verified === false ||
      payment.provider_payload?.simulated === true || payment.provider_payload?.live_mode === false ||
      payment.source !== undefined && !approvedSources.has(payment.source)) return denied('AUTO_RENEWAL_PAYMENT_UNVERIFIED');
  if (confirmed < activated || providerApproved < activated) return denied('AUTO_RENEWAL_PAYMENT_BEFORE_ACTIVATION');
  if (providerApproved > confirmed) return denied('AUTO_RENEWAL_PAYMENT_UNVERIFIED');

  const code = renewal.plan_code;
  if (!Object.hasOwn(PLAN_MONTHS, code)) return denied('AUTO_RENEWAL_PLAN_MISMATCH');
  const mapping = policy.plans?.[code];
  if (!mapping || !positiveInteger(mapping.durationMonths) || !positiveInteger(mapping.priceCents) || !positiveInteger(mapping.creditCost))
    return denied('AUTO_RENEWAL_MAPPING_REQUIRED');
  if (mapping.durationMonths !== PLAN_MONTHS[code] || renewal.duration_months !== mapping.durationMonths ||
      renewal.requested_extension_months !== mapping.durationMonths) return denied('AUTO_RENEWAL_PLAN_MISMATCH');
  if (mapping.creditCost > policy.maxCreditsPerRenewal) return denied('AUTO_RENEWAL_CREDIT_LIMIT');
  const chargeAmount = renewal.charge_amount_cents ?? renewal.amount_cents;
  if (!positiveInteger(payment.amount_cents) || payment.amount_cents !== mapping.priceCents ||
      chargeAmount !== mapping.priceCents || renewal.plan_price_cents !== mapping.priceCents)
    return denied('AUTO_RENEWAL_PRICE_MISMATCH');

  return { allowed: true, requiresApproval: false, code: 'AUTO_RENEWAL_ALLOWED', creditCost: mapping.creditCost };
}
