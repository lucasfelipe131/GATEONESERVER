import { detectPromptInjection } from './conversation-intents.js';

export const SUPPORT_CATEGORIES = Object.freeze([
  'ACCOUNT_ACCESS',
  'SUBSCRIPTION_STATUS',
  'PAYMENT',
  'RENEWAL',
  'SERVICE_UNAVAILABLE',
  'CONFIGURATION',
  'DEVICE_HELP',
  'HOW_TO',
  'COMPLAINT',
  'CANCELLATION',
  'UNKNOWN',
]);
export const SUPPORT_SEVERITIES = Object.freeze([
  'LOW',
  'MEDIUM',
  'HIGH',
  'CRITICAL',
]);
export const SUPPORT_LIMITS = Object.freeze({
  max_resolution_attempts: 2,
  max_tool_calls: 16,
  max_retries_per_tool: 1,
  max_agent_turns: 3,
});
export const CASE_TRANSITIONS = Object.freeze({
  OPEN: ['TRIAGING', 'HUMAN_REQUIRED'],
  TRIAGING: [
    'AUTOMATED_RESOLUTION',
    'WAITING_CUSTOMER',
    'WAITING_SYSTEM',
    'HUMAN_REQUIRED',
  ],
  AUTOMATED_RESOLUTION: [
    'RESOLVED',
    'WAITING_CUSTOMER',
    'WAITING_SYSTEM',
    'HUMAN_REQUIRED',
  ],
  WAITING_CUSTOMER: ['TRIAGING', 'HUMAN_REQUIRED', 'RESOLVED'],
  WAITING_SYSTEM: ['TRIAGING', 'HUMAN_REQUIRED', 'RESOLVED'],
  HUMAN_REQUIRED: ['WAITING_CUSTOMER', 'RESOLVED'],
  RESOLVED: ['CLOSED'],
  CLOSED: [],
});
export const EXCEPTION_TRANSITIONS = Object.freeze({
  OPEN: [
    'ACKNOWLEDGED',
    'IN_PROGRESS',
    'WAITING_CUSTOMER',
    'RESOLVED',
    'DISMISSED',
  ],
  ACKNOWLEDGED: ['IN_PROGRESS', 'WAITING_CUSTOMER', 'RESOLVED', 'DISMISSED'],
  IN_PROGRESS: ['WAITING_CUSTOMER', 'RESOLVED', 'DISMISSED'],
  WAITING_CUSTOMER: ['IN_PROGRESS', 'RESOLVED', 'DISMISSED'],
  RESOLVED: [],
  DISMISSED: [],
});
export function supportError(code) {
  return Object.assign(new Error(code), { code });
}
export function transitionCase(
  row,
  status,
  { verified = false, human = false } = {},
) {
  if (!CASE_TRANSITIONS[row.status]?.includes(status))
    throw supportError('INVALID_CASE_TRANSITION');
  if (status === 'RESOLVED' && !verified)
    throw supportError('VERIFICATION_REQUIRED');
  if (row.status === 'HUMAN_REQUIRED' && status === 'RESOLVED' && !human)
    throw supportError('HUMAN_REQUIRED');
  return { ...row, status };
}
export function transitionException(row, status) {
  if (!EXCEPTION_TRANSITIONS[row.status]?.includes(status))
    throw supportError('INVALID_EXCEPTION_TRANSITION');
  return { ...row, status };
}
const unwrap = (value) => value?.value ?? value;
export function triageSupport({
  text = '',
  context = {},
  intent = 'SUPPORT_REQUEST',
  attempts = 0,
  probe = null,
  now = new Date(),
}) {
  if (detectPromptInjection(text)) throw supportError('UNTRUSTED_INSTRUCTION');
  const t = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  const security = /fraude|invadiram|vazamento|roubaram/.test(t);
  const financial = context.financial?.reconciliation_status === 'DIVERGENT';
  const cancelled = intent === 'CANCELLATION_REQUEST';
  const human = intent === 'HUMAN_REQUEST';
  const complaint = intent === 'COMPLAINT';
  const expiration = unwrap(context.subscription?.expires_at);
  const expiredByDate = typeof expiration === 'string' && /^\d{4}-\d{2}-\d{2}/.test(expiration)
    && expiration.slice(0, 10) < now.toISOString().slice(0, 10);
  const expired = expiredByDate || ['EXPIRED', 'PAST_DUE', 'BLOCKED'].includes(
    String(unwrap(context.subscription?.status)).toUpperCase(),
  );
  const category = cancelled
    ? 'CANCELLATION'
    : complaint
      ? 'COMPLAINT'
      : financial
        ? 'PAYMENT'
        : security
          ? 'ACCOUNT_ACCESS'
          : expired
            ? 'SUBSCRIPTION_STATUS'
            : /configura/.test(t)
              ? 'CONFIGURATION'
              : /dispositivo|televisao|tv/.test(t)
                ? 'DEVICE_HELP'
                : /nao (esta |ta )?funcionando|sem sinal|nao abre|travando/.test(
                      t,
                    )
                  ? 'SERVICE_UNAVAILABLE'
                  : /como usar/.test(t)
                    ? 'HOW_TO'
                    : 'UNKNOWN';
  // Tone shortens the loop, but is not evidence of an operational emergency.
  const dissatisfied =
    /porra|merda|pessimo|irritad|absurdo/.test(t) || complaint;
  const eligible =
    !human && !cancelled && !complaint && !security && !financial && !expired;
  const known =
    probe?.synthetic === true && probe?.problem_code === 'STALE_SESSION';
  return {
    category,
    severity: security
      ? 'CRITICAL'
      : financial || expired || attempts >= 2
        ? 'HIGH'
        : category === 'SERVICE_UNAVAILABLE'
          ? 'MEDIUM'
          : 'LOW',
    confidence:
      known &&
      eligible &&
      String(unwrap(context.subscription?.status)).toUpperCase() === 'ACTIVE'
        ? 0.95
        : 0.35,
    customer_impact: expired
      ? 'ACCESS_EXPIRED'
      : category === 'SERVICE_UNAVAILABLE'
        ? 'SERVICE_BLOCKED'
        : 'SINGLE_CUSTOMER',
    automation_eligibility: eligible,
    recommended_action: human
      ? 'HUMAN_REQUEST'
      : security
        ? 'SECURITY_REVIEW'
        : financial
          ? 'FINANCIAL_DIVERGENCE'
          : cancelled
            ? 'CANCELLATION'
            : complaint
              ? 'SENSITIVE_COMPLAINT'
              : known && eligible
                ? 'REFRESH_SYNTHETIC_SESSION'
                : 'DIAGNOSE_WITH_HUMAN',
    problem_code: known ? 'STALE_SESSION' : category,
    dissatisfied,
    max_resolution_attempts: dissatisfied
      ? 1
      : SUPPORT_LIMITS.max_resolution_attempts,
  };
}
export function exceptionPriority(row, now = Date.now()) {
  const base =
    { LOW: 10, MEDIUM: 30, HIGH: 60, CRITICAL: 90 }[row.severity] || 10;
  const age = Math.max(0, (now - Date.parse(row.created_at)) / 3600000);
  return Math.min(
    100,
    base +
      Math.min(15, Math.floor(age)) +
      Math.min(10, (row.repetitions || 1) * 2) +
      (row.financial_risk ? 10 : 0) +
      (row.churn_risk ? 5 : 0) +
      (row.security_risk ? 10 : 0),
  );
}
export function knowledgeMetrics(row, success, now) {
  const attempt_count = (row.attempt_count || 0) + 1;
  const success_count = (row.success_count || 0) + Number(success);
  const failure_count = (row.failure_count || 0) + Number(!success);
  const success_rate = success_count / attempt_count;
  return {
    ...row,
    attempt_count,
    success_count,
    failure_count,
    success_rate,
    confidence: Math.min(row.confidence, success_rate),
    review_required: failure_count >= 2 || success_rate < 0.7,
    updated_at: now,
  };
}
export const AUTONOMY_DEFINITIONS = Object.freeze({
  eligible:
    'Identified support requests without explicit human request, cancellation, complaint, security/financial divergence or expired subscription; known solution is NOT required. Eligibility is frozen at opening and failures remain in denominator.',
  autonomous_resolution_rate:
    'eligible verified-resolved cases without human intervention / all eligible cases',
  human_handoff_rate: 'cases requiring human intervention / all cases',
  exception_rate: 'cases with an exception / all cases',
  autonomous_renewal_rate:
    'completed autonomous renewal decisions / eligible renewal decisions',
  tool_success_rate:
    'successful audited tool executions / all audited tool executions (including failures)',
  first_response_time:
    'average milliseconds from case opening to first recorded agent outcome',
  time_to_resolution:
    'average milliseconds from opening to verified resolution',
  repeat_contact_rate: 'cases linked to a previous resolved case / all cases',
});
