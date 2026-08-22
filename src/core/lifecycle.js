import { CUSTOMER_LIFECYCLE_STATES } from './contracts.js';

const TRANSITIONS = Object.freeze({
  LEAD: Object.freeze({ CONTACTED: [], QUALIFIED: [], BLOCKED: ['ADMIN_BLOCKED'] }),
  CONTACTED: Object.freeze({ QUALIFIED: [], CHURNED: ['CUSTOMER_LOST'], BLOCKED: ['ADMIN_BLOCKED'] }),
  QUALIFIED: Object.freeze({ TRIAL: [], WAITING_PAYMENT: [], CHURNED: ['CUSTOMER_LOST'], BLOCKED: ['ADMIN_BLOCKED'] }),
  TRIAL: Object.freeze({ WAITING_PAYMENT: [], ACTIVE: ['SUBSCRIPTION_ACTIVATED'], CHURNED: ['TRIAL_ENDED'], BLOCKED: ['ADMIN_BLOCKED'] }),
  WAITING_PAYMENT: Object.freeze({ ACTIVE: ['SUBSCRIPTION_ACTIVATED'], PAST_DUE: ['PAYMENT_OVERDUE'], CHURNED: ['CUSTOMER_LOST'], BLOCKED: ['ADMIN_BLOCKED'] }),
  ACTIVE: Object.freeze({ EXPIRING: ['SUBSCRIPTION_EXPIRING'], BLOCKED: ['ADMIN_BLOCKED'] }),
  EXPIRING: Object.freeze({ RENEWAL_PENDING: ['RENEWAL_REQUESTED'], PAST_DUE: ['SUBSCRIPTION_EXPIRED'], ACTIVE: ['RENEWAL_COMPLETED'], BLOCKED: ['ADMIN_BLOCKED'] }),
  RENEWAL_PENDING: Object.freeze({ ACTIVE: ['RENEWAL_COMPLETED'], PAST_DUE: ['SUBSCRIPTION_EXPIRED'], RECOVERY: ['RENEWAL_FAILED'], BLOCKED: ['ADMIN_BLOCKED'] }),
  PAST_DUE: Object.freeze({ RECOVERY: ['RECOVERY_STARTED'], ACTIVE: ['RENEWAL_COMPLETED'], CHURNED: ['CUSTOMER_LOST'], BLOCKED: ['ADMIN_BLOCKED'] }),
  RECOVERY: Object.freeze({ WAITING_PAYMENT: ['PAYMENT_REQUESTED'], ACTIVE: ['RENEWAL_COMPLETED'], CHURNED: ['CUSTOMER_LOST'], BLOCKED: ['ADMIN_BLOCKED'] }),
  CHURNED: Object.freeze({ RECOVERY: ['RECOVERY_STARTED'], BLOCKED: ['ADMIN_BLOCKED'] }),
  BLOCKED: Object.freeze({ LEAD: ['ADMIN_UNBLOCKED'], ACTIVE: ['ADMIN_UNBLOCKED'] })
});

export const CUSTOMER_LIFECYCLE_TRANSITIONS = TRANSITIONS;

export function lifecycleFromLegacyStatus(status) {
  return ({
    lead: 'LEAD',
    active: 'ACTIVE',
    late: 'PAST_DUE',
    suspended: 'BLOCKED',
    cancelled: 'CHURNED'
  })[String(status || '').toLowerCase()] || 'LEAD';
}

export function transitionCustomerLifecycle({ current, next, event }) {
  if (!CUSTOMER_LIFECYCLE_STATES.includes(current)) {
    return { allowed: false, code: 'INVALID_TRANSITION', reason: 'UNKNOWN_CURRENT_STATE' };
  }
  if (!CUSTOMER_LIFECYCLE_STATES.includes(next)) {
    return { allowed: false, code: 'INVALID_TRANSITION', reason: 'UNKNOWN_NEXT_STATE' };
  }
  if (current === next) return { allowed: true, changed: false, current, next };
  const requiredEvents = TRANSITIONS[current]?.[next];
  if (!requiredEvents) {
    return { allowed: false, code: 'INVALID_TRANSITION', reason: 'PATH_NOT_ALLOWED' };
  }
  if (requiredEvents.length && !requiredEvents.includes(event)) {
    return {
      allowed: false,
      code: 'INVALID_TRANSITION',
      reason: 'CONDITION_NOT_MET',
      required_events: requiredEvents
    };
  }
  return { allowed: true, changed: true, current, next, event };
}
