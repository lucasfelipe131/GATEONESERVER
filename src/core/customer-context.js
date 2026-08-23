import {
  CUSTOMER_CONTEXT_PURPOSES,
  CUSTOMER_CONTEXT_SCOPES,
  FRESHNESS_STATES
} from './contracts.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const PURPOSE_SCOPES = Object.freeze({
  CONVERSATION: Object.freeze([
    'IDENTITY',
    'LIFECYCLE',
    'SUBSCRIPTION',
    'CONVERSATION',
    'SUPPORT',
    'MEMORY',
    'PENDING_ACTIONS'
  ]),
  RENEWAL: Object.freeze([
    'IDENTITY',
    'LIFECYCLE',
    'SUBSCRIPTION',
    'PAYMENT',
    'RENEWAL',
    'PENDING_ACTIONS'
  ]),
  PAYMENT: Object.freeze([
    'IDENTITY',
    'SUBSCRIPTION',
    'PAYMENT',
    'RENEWAL',
    'PENDING_ACTIONS'
  ]),
  SUPPORT: Object.freeze([
    'IDENTITY',
    'SUBSCRIPTION',
    'CONVERSATION',
    'SUPPORT',
    'MEMORY',
    'PENDING_ACTIONS'
  ]),
  SALES: Object.freeze([
    'IDENTITY',
    'LIFECYCLE',
    'SUBSCRIPTION',
    'CONVERSATION',
    'MEMORY'
  ])
});

const DOMAIN_WINDOWS = Object.freeze({
  identity: Object.freeze({ current: 365 * DAY, historical: 730 * DAY }),
  lifecycle: Object.freeze({ current: 30 * DAY, historical: 180 * DAY }),
  subscription: Object.freeze({ current: DAY, historical: 30 * DAY }),
  payment: Object.freeze({ current: DAY, historical: 90 * DAY }),
  renewal: Object.freeze({ current: DAY, historical: 30 * DAY }),
  conversation: Object.freeze({ current: 6 * HOUR, historical: 7 * DAY }),
  support: Object.freeze({ current: 7 * DAY, historical: 90 * DAY }),
  preference: Object.freeze({ current: 365 * DAY, historical: 730 * DAY }),
  relationship: Object.freeze({ current: 365 * DAY, historical: 1095 * DAY }),
  support_memory: Object.freeze({ current: 30 * DAY, historical: 180 * DAY }),
  commercial_memory: Object.freeze({ current: 90 * DAY, historical: 365 * DAY }),
  operational_memory: Object.freeze({ current: 7 * DAY, historical: 30 * DAY })
});

const EVENT_SCOPE_PREFIXES = Object.freeze([
  ['customer.created', ['IDENTITY', 'LIFECYCLE']],
  ['customer.identified', ['IDENTITY']],
  ['customer.status_changed', ['LIFECYCLE']],
  ['subscription.', ['SUBSCRIPTION', 'PENDING_ACTIONS']],
  ['payment.', ['PAYMENT', 'PENDING_ACTIONS']],
  ['renewal.', ['RENEWAL', 'PENDING_ACTIONS']],
  ['provisioning.', ['PENDING_ACTIONS']],
  ['conversation.', ['CONVERSATION', 'PENDING_ACTIONS']],
  ['message.', ['CONVERSATION']],
  ['support.', ['SUPPORT', 'PENDING_ACTIONS']]
]);

export function customerContextError(code, message, details = undefined) {
  return Object.assign(new Error(message), { code, details });
}

export function normalizeContextPurpose(value) {
  const purpose = String(value || '').trim().toUpperCase();
  if (!CUSTOMER_CONTEXT_PURPOSES.includes(purpose)) {
    throw customerContextError('INVALID_PURPOSE', 'Finalidade de contexto inválida.', {
      purpose,
      allowed: CUSTOMER_CONTEXT_PURPOSES
    });
  }
  return purpose;
}

export function selectContextScopes({ purpose, requestedScopes = null }) {
  const normalizedPurpose = normalizeContextPurpose(purpose);
  const allowed = PURPOSE_SCOPES[normalizedPurpose];
  const requested = Array.isArray(requestedScopes)
    ? [...new Set(requestedScopes.map((scope) => String(scope).trim().toUpperCase()))]
    : [...allowed];
  const selected = requested.filter(
    (scope) => CUSTOMER_CONTEXT_SCOPES.includes(scope) && allowed.includes(scope)
  );
  const excluded = requested.filter((scope) => !selected.includes(scope));
  const exclusionReasonCodes = [];
  if (excluded.some((scope) => !CUSTOMER_CONTEXT_SCOPES.includes(scope))) {
    exclusionReasonCodes.push('UNKNOWN_SCOPE');
  }
  if (excluded.some((scope) => CUSTOMER_CONTEXT_SCOPES.includes(scope))) {
    exclusionReasonCodes.push('PURPOSE_SCOPE_DENIED');
  }
  if (!selected.length) {
    throw customerContextError('INSUFFICIENT_CAPABILITY', 'Nenhum scope de contexto foi autorizado.', {
      purpose: normalizedPurpose,
      requested_scopes: requested
    });
  }
  return {
    purpose: normalizedPurpose,
    requested,
    selected,
    excluded,
    exclusionReasonCodes
  };
}

export function freshnessFor(domain, observedAt, {
  now = new Date(),
  validUntil = null
} = {}) {
  if (!observedAt) return 'UNKNOWN';
  const observed = new Date(observedAt);
  const currentTime = new Date(now);
  if (!Number.isFinite(observed.getTime()) || !Number.isFinite(currentTime.getTime())) {
    return 'UNKNOWN';
  }
  if (validUntil) {
    const expiration = new Date(validUntil);
    if (Number.isFinite(expiration.getTime()) && expiration <= currentTime) return 'STALE';
  }
  const windows = DOMAIN_WINDOWS[domain];
  if (!windows) return 'UNKNOWN';
  const age = Math.max(0, currentTime.getTime() - observed.getTime());
  if (age <= windows.current) return 'CURRENT';
  if (age <= windows.historical) return 'HISTORICAL';
  return 'STALE';
}

export function provenance(value, {
  source,
  sourceId = null,
  observedAt,
  domain,
  validUntil = null,
  now = new Date()
}) {
  if (value === null || value === undefined || value === '') return null;
  return {
    value,
    source,
    source_id: sourceId ? String(sourceId) : null,
    observed_at: new Date(observedAt || now).toISOString(),
    freshness: freshnessFor(domain, observedAt || now, { now, validUntil })
  };
}

export function contextStatus(missingFields = []) {
  return missingFields.length ? 'PARTIAL' : 'COMPLETE';
}

export function assertFreshnessState(value) {
  if (!FRESHNESS_STATES.includes(value)) {
    throw new Error(`Freshness inválida: ${value}`);
  }
  return value;
}

export function contextImpactForEvent(eventType) {
  const value = String(eventType || '');
  const match = EVENT_SCOPE_PREFIXES.find(([prefix]) =>
    prefix.endsWith('.') ? value.startsWith(prefix) : value === prefix
  );
  return {
    event_type: value,
    affected_scopes: match ? [...match[1]] : [],
    snapshots_are_immutable: true,
    invalidate_future_reads: Boolean(match)
  };
}

export { PURPOSE_SCOPES };
