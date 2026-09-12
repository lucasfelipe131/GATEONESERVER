ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS lifecycle_status text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'customers_lifecycle_status_check'
  ) THEN
    ALTER TABLE customers
      ADD CONSTRAINT customers_lifecycle_status_check
      CHECK (lifecycle_status IS NULL OR lifecycle_status IN (
        'LEAD', 'CONTACTED', 'QUALIFIED', 'TRIAL', 'WAITING_PAYMENT', 'ACTIVE',
        'EXPIRING', 'RENEWAL_PENDING', 'PAST_DUE', 'RECOVERY', 'CHURNED', 'BLOCKED'
      )) NOT VALID;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS customer_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  identity_type text NOT NULL CHECK (identity_type IN (
    'WHATSAPP', 'PHONE', 'EMAIL', 'LOGIN', 'PROVIDER_ACCOUNT', 'PARTNER_ID'
  )),
  provider text NOT NULL DEFAULT 'core',
  external_id text NOT NULL,
  normalized_value text NOT NULL,
  verified_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (identity_type, provider, normalized_value)
);
CREATE INDEX IF NOT EXISTS customer_identities_customer_idx
  ON customer_identities (customer_id, identity_type);

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS provider text,
  ADD COLUMN IF NOT EXISTS provider_reference text,
  ADD COLUMN IF NOT EXISTS renewal_policy jsonb;

CREATE TABLE IF NOT EXISTS payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  subscription_id uuid NOT NULL REFERENCES subscriptions(id) ON DELETE RESTRICT,
  charge_id uuid REFERENCES charges(id) ON DELETE SET NULL,
  provider text NOT NULL,
  external_payment_id text,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  currency text NOT NULL DEFAULT 'BRL' CHECK (char_length(currency) = 3),
  status text NOT NULL CHECK (status IN (
    'CREATED', 'PENDING', 'CONFIRMED', 'FAILED', 'EXPIRED', 'CANCELLED', 'REFUNDED'
  )),
  idempotency_key text NOT NULL UNIQUE,
  correlation_id uuid NOT NULL,
  provider_payload jsonb,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS payments_provider_external_unique
  ON payments (provider, external_payment_id)
  WHERE external_payment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS payments_subscription_created_idx
  ON payments (subscription_id, created_at DESC);

ALTER TABLE charges
  ADD COLUMN IF NOT EXISTS correlation_id uuid;

ALTER TABLE renewal_jobs
  ADD COLUMN IF NOT EXISTS payment_id uuid REFERENCES payments(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS core_status text,
  ADD COLUMN IF NOT EXISTS previous_expiration date,
  ADD COLUMN IF NOT EXISTS requested_extension_months integer,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS failure_reason text,
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS correlation_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'renewal_jobs_core_status_check'
  ) THEN
    ALTER TABLE renewal_jobs
      ADD CONSTRAINT renewal_jobs_core_status_check
      CHECK (core_status IS NULL OR core_status IN (
        'REQUESTED', 'WAITING_PAYMENT', 'READY', 'PROCESSING', 'VERIFYING',
        'COMPLETED', 'FAILED', 'HUMAN_ACTION_REQUIRED'
      )) NOT VALID;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS renewal_jobs_idempotency_unique
  ON renewal_jobs (idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS provisioning_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  subscription_id uuid NOT NULL REFERENCES subscriptions(id) ON DELETE RESTRICT,
  renewal_id uuid REFERENCES renewal_jobs(id) ON DELETE SET NULL,
  provider text NOT NULL,
  operation text NOT NULL CHECK (operation IN (
    'LOOKUP', 'CREATE', 'RENEW', 'GET_EXPIRATION', 'GET_STATUS'
  )),
  status text NOT NULL CHECK (status IN (
    'REQUESTED', 'PROCESSING', 'COMPLETED', 'FAILED', 'HUMAN_ACTION_REQUIRED'
  )),
  provider_reference text,
  idempotency_key text NOT NULL UNIQUE,
  correlation_id uuid NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  result jsonb,
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE customer_issues
  ADD COLUMN IF NOT EXISTS correlation_id uuid,
  ADD COLUMN IF NOT EXISTS idempotency_key text;
CREATE UNIQUE INDEX IF NOT EXISTS customer_issues_idempotency_unique
  ON customer_issues (idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS gate_event_outbox (
  event_id uuid PRIMARY KEY,
  event_type text NOT NULL,
  event_version integer NOT NULL CHECK (event_version > 0),
  occurred_at timestamptz NOT NULL,
  correlation_id uuid NOT NULL,
  causation_id uuid,
  actor jsonb NOT NULL,
  subject jsonb NOT NULL,
  payload jsonb NOT NULL,
  publish_status text NOT NULL DEFAULT 'PENDING'
    CHECK (publish_status IN ('PENDING', 'PUBLISHED', 'FAILED')),
  publish_attempts integer NOT NULL DEFAULT 0,
  published_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gate_event_outbox_pending_idx
  ON gate_event_outbox (created_at)
  WHERE publish_status IN ('PENDING', 'FAILED');
CREATE INDEX IF NOT EXISTS gate_event_outbox_correlation_idx
  ON gate_event_outbox (correlation_id, occurred_at);

CREATE TABLE IF NOT EXISTS gate_event_consumptions (
  consumer text NOT NULL,
  event_id uuid NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, event_id)
);
