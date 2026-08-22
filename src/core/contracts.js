import { z } from 'zod';

export const CORE_CONTRACT_VERSION = 1;

export const CUSTOMER_LIFECYCLE_STATES = Object.freeze([
  'LEAD',
  'CONTACTED',
  'QUALIFIED',
  'TRIAL',
  'WAITING_PAYMENT',
  'ACTIVE',
  'EXPIRING',
  'RENEWAL_PENDING',
  'PAST_DUE',
  'RECOVERY',
  'CHURNED',
  'BLOCKED'
]);

export const IDENTITY_RESOLUTION_STATUSES = Object.freeze([
  'MATCHED',
  'AMBIGUOUS',
  'NOT_FOUND'
]);

export const IDENTITY_TYPES = Object.freeze([
  'WHATSAPP',
  'PHONE',
  'EMAIL',
  'LOGIN',
  'PROVIDER_ACCOUNT',
  'PARTNER_ID'
]);

export const PAYMENT_STATUSES = Object.freeze([
  'CREATED',
  'PENDING',
  'CONFIRMED',
  'FAILED',
  'EXPIRED',
  'CANCELLED',
  'REFUNDED'
]);

export const RENEWAL_STATUSES = Object.freeze([
  'REQUESTED',
  'WAITING_PAYMENT',
  'READY',
  'PROCESSING',
  'VERIFYING',
  'COMPLETED',
  'FAILED',
  'HUMAN_ACTION_REQUIRED'
]);

export const PROVISIONING_STATUSES = Object.freeze([
  'REQUESTED',
  'PROCESSING',
  'COMPLETED',
  'FAILED',
  'HUMAN_ACTION_REQUIRED'
]);

export const CORE_EVENT_TYPES = Object.freeze([
  'customer.created',
  'customer.identified',
  'customer.status_changed',
  'lead.created',
  'lead.qualified',
  'payment.created',
  'payment.pending',
  'payment.confirmed',
  'payment.failed',
  'subscription.created',
  'subscription.activated',
  'subscription.expiring',
  'subscription.expired',
  'renewal.requested',
  'renewal.ready',
  'renewal.processing',
  'renewal.completed',
  'renewal.failed',
  'provisioning.requested',
  'provisioning.completed',
  'provisioning.failed',
  'provisioning.human_action_required',
  'conversation.started',
  'message.received',
  'message.sent',
  'conversation.handoff_requested',
  'support.case_opened',
  'support.case_resolved'
]);

export const CORE_RESPONSE_STATUSES = Object.freeze([
  'SUCCESS',
  'PENDING',
  'REQUIRES_ACTION',
  'DENIED',
  'FAILED'
]);

export const CORE_ERROR_CODES = Object.freeze([
  'CUSTOMER_NOT_FOUND',
  'CUSTOMER_IDENTITY_AMBIGUOUS',
  'INVALID_TRANSITION',
  'PAYMENT_NOT_CONFIRMED',
  'RENEWAL_ALREADY_COMPLETED',
  'PROVIDER_UNAVAILABLE',
  'HUMAN_ACTION_REQUIRED',
  'INSUFFICIENT_CAPABILITY',
  'STEP_UP_REQUIRED',
  'UNSUPPORTED_ACTION',
  'CONTRACT_VERSION_UNSUPPORTED',
  'CORRELATION_MISMATCH'
]);

export const actorSchema = z.object({
  type: z.enum(['CUSTOMER', 'ADMIN', 'AGENT', 'SYSTEM', 'WORKER', 'SERVICE']),
  id: z.string().min(1).max(200),
  capability: z.string().min(1).max(200).optional()
});

export const subjectSchema = z.object({
  type: z.string().min(1).max(100),
  id: z.string().min(1).max(200).optional()
});

export const eventEnvelopeSchema = z.object({
  event_id: z.uuid(),
  event_type: z.enum(CORE_EVENT_TYPES),
  event_version: z.int().min(1),
  occurred_at: z.iso.datetime(),
  correlation_id: z.uuid(),
  causation_id: z.uuid().nullable(),
  actor: actorSchema,
  subject: subjectSchema,
  payload: z.record(z.string(), z.unknown())
});

export const coreRequestSchema = z.object({
  contract_version: z.literal(CORE_CONTRACT_VERSION),
  request_id: z.uuid(),
  correlation_id: z.uuid(),
  actor: actorSchema.extend({ capability: z.string().min(1).max(200) }),
  action: z.string().min(1).max(200),
  subject: subjectSchema,
  input: z.record(z.string(), z.unknown())
});

export const coreErrorSchema = z.object({
  code: z.enum(CORE_ERROR_CODES),
  message: z.string().min(1).max(500),
  details: z.record(z.string(), z.unknown()).optional()
});

export const coreResponseSchema = z.object({
  contract_version: z.literal(CORE_CONTRACT_VERSION),
  request_id: z.uuid(),
  correlation_id: z.uuid(),
  status: z.enum(CORE_RESPONSE_STATUSES),
  data: z.unknown().nullable(),
  error: coreErrorSchema.nullable()
});

export const customerIdentitySchema = z.object({
  customer_id: z.uuid(),
  identity_type: z.enum(IDENTITY_TYPES),
  provider: z.string().min(1).max(100),
  external_id: z.string().min(1).max(500),
  verified_at: z.iso.datetime().nullable()
});

export const subscriptionContractSchema = z.object({
  subscription_id: z.uuid(),
  customer_id: z.uuid(),
  plan_id: z.uuid(),
  status: z.string().min(1),
  started_at: z.string().min(1),
  expires_at: z.string().min(1),
  provider: z.string().nullable(),
  provider_reference: z.string().nullable(),
  renewal_policy: z.record(z.string(), z.unknown()).nullable(),
  created_at: z.string().min(1),
  updated_at: z.string().min(1)
});

export const paymentContractSchema = z.object({
  payment_id: z.uuid(),
  customer_id: z.uuid(),
  subscription_id: z.uuid(),
  provider: z.string().min(1),
  external_payment_id: z.string().nullable(),
  amount_cents: z.int().positive(),
  currency: z.string().length(3),
  status: z.enum(PAYMENT_STATUSES),
  created_at: z.string().min(1),
  confirmed_at: z.string().nullable(),
  idempotency_key: z.string().min(1)
});

export const renewalContractSchema = z.object({
  renewal_id: z.uuid(),
  customer_id: z.uuid(),
  subscription_id: z.uuid(),
  payment_id: z.uuid().nullable(),
  previous_expiration: z.string().nullable(),
  requested_extension_months: z.int().positive().nullable(),
  status: z.enum(RENEWAL_STATUSES),
  requested_at: z.string().min(1),
  completed_at: z.string().nullable(),
  failure_reason: z.string().nullable(),
  idempotency_key: z.string().min(1)
});

export const provisioningContractSchema = z.object({
  provisioning_id: z.uuid(),
  customer_id: z.uuid(),
  subscription_id: z.uuid(),
  renewal_id: z.uuid().nullable(),
  provider: z.string().min(1),
  operation: z.enum(['LOOKUP', 'CREATE', 'RENEW', 'GET_EXPIRATION', 'GET_STATUS']),
  status: z.enum(PROVISIONING_STATUSES),
  provider_reference: z.string().nullable(),
  idempotency_key: z.string().min(1)
});

export const conversationContractSchema = z.object({
  conversation_id: z.string().min(1),
  customer_id: z.uuid().nullable(),
  channel: z.string().min(1),
  state: z.string().min(1),
  correlation_id: z.uuid(),
  started_at: z.string().min(1),
  updated_at: z.string().min(1)
});

export const supportCaseContractSchema = z.object({
  support_case_id: z.uuid(),
  customer_id: z.uuid(),
  category: z.string().min(1),
  summary: z.string().min(1),
  status: z.enum(['OPEN', 'MONITORING', 'RESOLVED']),
  correlation_id: z.uuid(),
  opened_at: z.string().min(1),
  resolved_at: z.string().nullable()
});

export function coreResponse(request, {
  status = 'SUCCESS',
  data = null,
  error = null
} = {}) {
  return coreResponseSchema.parse({
    contract_version: CORE_CONTRACT_VERSION,
    request_id: request.request_id,
    correlation_id: request.correlation_id,
    status,
    data,
    error
  });
}
