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

export const CUSTOMER_CONTEXT_PURPOSES = Object.freeze([
  'CONVERSATION',
  'RENEWAL',
  'PAYMENT',
  'SUPPORT',
  'SALES'
]);

export const CUSTOMER_CONTEXT_SCOPES = Object.freeze([
  'IDENTITY',
  'LIFECYCLE',
  'SUBSCRIPTION',
  'PAYMENT',
  'RENEWAL',
  'CONVERSATION',
  'SUPPORT',
  'MEMORY',
  'PENDING_ACTIONS'
]);

export const MEMORY_TYPES = Object.freeze([
  'IDENTITY_FACT',
  'PREFERENCE',
  'RELATIONSHIP',
  'SUPPORT_FACT',
  'COMMERCIAL_CONTEXT',
  'OPERATIONAL_NOTE'
]);

export const MEMORY_STATUSES = Object.freeze([
  'ACTIVE',
  'SUPERSEDED',
  'DISPUTED',
  'EXPIRED',
  'DELETED'
]);

export const MEMORY_CONFIDENCE = Object.freeze(['HIGH', 'MEDIUM', 'LOW']);

export const CONVERSATION_STATES = Object.freeze([
  'NEW_CONTACT',
  'GENERAL',
  'SALES',
  'WAITING_PAYMENT',
  'RENEWAL',
  'SUPPORT',
  'RECOVERY',
  'HUMAN_HANDOFF'
]);

export const FRESHNESS_STATES = Object.freeze([
  'CURRENT',
  'HISTORICAL',
  'STALE',
  'UNKNOWN'
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
  'CUSTOMER_AMBIGUOUS',
  'CONTEXT_UNAVAILABLE',
  'CONTEXT_PARTIAL',
  'SUBSCRIPTION_NOT_FOUND',
  'INVALID_PURPOSE',
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

export const provenanceSchema = z.object({
  value: z.unknown(),
  source: z.string().min(1).max(100),
  source_id: z.string().max(200).nullable(),
  observed_at: z.string().min(1),
  freshness: z.enum(FRESHNESS_STATES)
});

export const memoryRecordSchema = z.object({
  memory_id: z.uuid(),
  customer_id: z.uuid(),
  type: z.enum(MEMORY_TYPES),
  key: z.string().min(1).max(200),
  value: z.unknown(),
  source: z.string().min(1).max(100),
  source_reference: z.string().max(500).nullable(),
  confidence: z.enum(MEMORY_CONFIDENCE),
  observed_at: z.string().min(1),
  valid_from: z.string().nullable(),
  valid_until: z.string().nullable(),
  superseded_by: z.uuid().nullable(),
  status: z.enum(MEMORY_STATUSES),
  freshness: z.enum(FRESHNESS_STATES)
});

const contextIdentitySchema = z.object({
  name: provenanceSchema.nullable(),
  identities: z.array(z.object({
    type: z.enum(IDENTITY_TYPES),
    provider: z.string().min(1),
    value: provenanceSchema
  }))
});

const contextSubscriptionSchema = z.object({
  subscription_id: z.uuid(),
  plan_code: provenanceSchema.nullable(),
  plan_name: provenanceSchema.nullable(),
  status: provenanceSchema,
  started_at: provenanceSchema.nullable(),
  expires_at: provenanceSchema.nullable(),
  provider: provenanceSchema.nullable(),
  provider_reference: provenanceSchema.nullable().optional()
});

export const customer360Schema = z.object({
  contract: z.literal('Customer360.v1'),
  customer_id: z.uuid(),
  resolution: z.object({
    status: z.enum(IDENTITY_RESOLUTION_STATUSES),
    matched_by: z.object({
      type: z.enum(IDENTITY_TYPES),
      provider: z.string().min(1)
    }).nullable()
  }),
  context_status: z.enum(['COMPLETE', 'PARTIAL']),
  selected_scopes: z.array(z.enum(CUSTOMER_CONTEXT_SCOPES)),
  identity: contextIdentitySchema.optional(),
  lifecycle: z.object({
    state: provenanceSchema,
    recent_transition: z.record(z.string(), z.unknown()).nullable()
  }).optional(),
  subscription: contextSubscriptionSchema.nullable().optional(),
  financial: z.object({
    current_charge: z.record(z.string(), z.unknown()).nullable(),
    last_payment: z.record(z.string(), z.unknown()).nullable(),
    pending_payment: z.record(z.string(), z.unknown()).nullable(),
    confirmed_payment: z.record(z.string(), z.unknown()).nullable()
  }).optional(),
  renewal: z.record(z.string(), z.unknown()).nullable().optional(),
  conversation: z.record(z.string(), z.unknown()).nullable().optional(),
  support: z.object({
    open_cases: z.array(z.record(z.string(), z.unknown())),
    last_case: z.record(z.string(), z.unknown()).nullable()
  }).optional(),
  memories: z.array(memoryRecordSchema).optional(),
  pending_actions: z.array(z.record(z.string(), z.unknown())).optional(),
  missing_fields: z.array(z.string())
});

export const contextSnapshotSchema = z.object({
  contract: z.literal('ContextSnapshot.v1'),
  context_snapshot_id: z.uuid(),
  customer_id: z.uuid(),
  correlation_id: z.uuid(),
  purpose: z.enum(CUSTOMER_CONTEXT_PURPOSES),
  channel: z.string().min(1).max(100),
  created_at: z.string().min(1),
  sources: z.array(z.object({
    source: z.string().min(1).max(100),
    source_id: z.string().max(200).nullable(),
    observed_at: z.string().min(1)
  })),
  customer360: customer360Schema,
  freshness: z.record(z.string(), z.enum(FRESHNESS_STATES)),
  selected_refs: z.array(z.record(z.string(), z.unknown())),
  excluded_refs: z.array(z.record(z.string(), z.unknown())),
  exclusion_reason_codes: z.array(z.string())
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
