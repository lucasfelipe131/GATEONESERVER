-- PASSO 04: EXPAND-only. No existing state is rewritten or backfilled here.

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS reconciliation_status text,
  ADD COLUMN IF NOT EXISTS provider_observed_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_external_event_id text,
  ADD COLUMN IF NOT EXISTS review_reason text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'payments_reconciliation_status_check'
  ) THEN
    ALTER TABLE payments
      ADD CONSTRAINT payments_reconciliation_status_check
      CHECK (reconciliation_status IS NULL OR reconciliation_status IN (
        'MATCHED', 'INTERNAL_STALE', 'EXTERNAL_STALE', 'DIVERGENT', 'REQUIRES_REVIEW'
      )) NOT VALID;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS payment_provider_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  external_event_id text NOT NULL,
  external_payment_id text NOT NULL,
  payment_id uuid REFERENCES payments(id) ON DELETE SET NULL,
  source text NOT NULL CHECK (source IN ('WEBHOOK', 'POLLING', 'RECONCILIATION', 'ADMIN')),
  normalized_status text NOT NULL CHECK (normalized_status IN (
    'CREATED', 'PENDING', 'CONFIRMED', 'FAILED', 'EXPIRED', 'CANCELLED', 'REFUNDED'
  )),
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  currency text NOT NULL CHECK (char_length(currency) = 3),
  observed_at timestamptz NOT NULL,
  signature_verified boolean NOT NULL DEFAULT false,
  payload jsonb,
  processed_at timestamptz,
  processing_error text,
  correlation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, external_event_id)
);
CREATE INDEX IF NOT EXISTS payment_provider_events_payment_idx
  ON payment_provider_events (provider, external_payment_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS payment_provider_events_unprocessed_idx
  ON payment_provider_events (created_at)
  WHERE processed_at IS NULL;

CREATE TABLE IF NOT EXISTS payment_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  payment_id uuid REFERENCES payments(id) ON DELETE SET NULL,
  source_message_id text,
  content_type text NOT NULL CHECK (content_type IN ('TEXT', 'IMAGE', 'PDF', 'DOCUMENT')),
  storage_reference text,
  status text NOT NULL DEFAULT 'RECEIVED' CHECK (status IN ('RECEIVED', 'UNDER_REVIEW', 'MATCHED', 'REJECTED')),
  correlation_id uuid NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS payment_evidence_message_unique
  ON payment_evidence (source_message_id) WHERE source_message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS renewal_sagas (
  renewal_id uuid PRIMARY KEY REFERENCES renewal_jobs(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  subscription_id uuid NOT NULL REFERENCES subscriptions(id) ON DELETE RESTRICT,
  payment_id uuid NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  correlation_id uuid NOT NULL,
  causation_id uuid,
  last_event_id uuid,
  previous_expiration date NOT NULL,
  target_expiration date NOT NULL,
  requested_extension_months integer NOT NULL CHECK (requested_extension_months > 0),
  expected_amount_cents integer NOT NULL CHECK (expected_amount_cents > 0),
  provisioning_provider text NOT NULL,
  state text NOT NULL CHECK (state IN (
    'REQUESTED', 'WAITING_PAYMENT', 'READY', 'PROCESSING', 'VERIFYING',
    'COMPLETED', 'FAILED', 'RETRY_SCHEDULED', 'HUMAN_ACTION_REQUIRED', 'CANCELLED'
  )),
  requested_by jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  last_error text,
  failure_class text CHECK (failure_class IS NULL OR failure_class IN (
    'TRANSIENT', 'AUTHENTICATION', 'HUMAN_REQUIRED', 'BUSINESS_RULE', 'PERMANENT', 'UNKNOWN'
  )),
  requested_at timestamptz NOT NULL DEFAULT now(),
  processing_at timestamptz,
  verified_at timestamptz,
  completed_at timestamptz,
  next_retry_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payment_id),
  UNIQUE (customer_id, subscription_id, payment_id)
);
CREATE INDEX IF NOT EXISTS renewal_sagas_state_retry_idx
  ON renewal_sagas (state, next_retry_at, updated_at);
CREATE INDEX IF NOT EXISTS renewal_sagas_customer_idx
  ON renewal_sagas (customer_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS renewal_sagas_subscription_idx
  ON renewal_sagas (subscription_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS renewal_sagas_correlation_idx
  ON renewal_sagas (correlation_id);
CREATE UNIQUE INDEX IF NOT EXISTS renewal_sagas_active_subscription_unique
  ON renewal_sagas (subscription_id)
  WHERE state IN ('REQUESTED', 'WAITING_PAYMENT', 'READY', 'PROCESSING', 'VERIFYING', 'RETRY_SCHEDULED');

ALTER TABLE provisioning_operations
  ADD COLUMN IF NOT EXISTS orchestration_state text,
  ADD COLUMN IF NOT EXISTS expected_expiration date,
  ADD COLUMN IF NOT EXISTS provider_expiration date,
  ADD COLUMN IF NOT EXISTS verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS next_retry_at timestamptz,
  ADD COLUMN IF NOT EXISTS failure_class text,
  ADD COLUMN IF NOT EXISTS causation_id uuid;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'provisioning_operations_orchestration_state_check'
  ) THEN
    ALTER TABLE provisioning_operations
      ADD CONSTRAINT provisioning_operations_orchestration_state_check
      CHECK (orchestration_state IS NULL OR orchestration_state IN (
        'REQUESTED', 'PROCESSING', 'VERIFYING', 'COMPLETED', 'FAILED',
        'RETRY_SCHEDULED', 'HUMAN_ACTION_REQUIRED'
      )) NOT VALID;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS provisioning_operations_retry_idx
  ON provisioning_operations (status, next_retry_at)
  WHERE status IN ('REQUESTED', 'PROCESSING', 'FAILED');
CREATE INDEX IF NOT EXISTS provisioning_operations_customer_idx
  ON provisioning_operations (customer_id, updated_at DESC);

ALTER TABLE gate_event_outbox
  ADD COLUMN IF NOT EXISTS claimed_by text,
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS terminal_at timestamptz;
CREATE INDEX IF NOT EXISTS gate_event_outbox_dispatch_idx
  ON gate_event_outbox (next_attempt_at, created_at)
  WHERE publish_status IN ('PENDING', 'FAILED');

CREATE TABLE IF NOT EXISTS notification_requests (
  id uuid PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  channel text NOT NULL CHECK (channel IN ('WHATSAPP', 'EMAIL', 'IN_APP')),
  intention text NOT NULL,
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  priority text NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('LOW', 'NORMAL', 'HIGH')),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENT', 'FAILED', 'CANCELLED')),
  correlation_id uuid NOT NULL,
  causation_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notification_requests_customer_idx
  ON notification_requests (customer_id, created_at DESC);

CREATE TABLE IF NOT EXISTS operational_transition_audit (
  id bigserial PRIMARY KEY,
  actor jsonb NOT NULL,
  operation text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  before_state jsonb,
  after_state jsonb,
  reason text,
  correlation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS operational_transition_audit_entity_idx
  ON operational_transition_audit (entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS operational_transition_audit_correlation_idx
  ON operational_transition_audit (correlation_id, created_at);
