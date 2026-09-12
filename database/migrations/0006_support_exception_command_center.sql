-- EXPAND ONLY. No remote application authorized by phase 06.
-- Keep the legacy open/monitoring/resolved constraint and project the richer state.
ALTER TABLE customer_issues ADD COLUMN IF NOT EXISTS support_data jsonb;
CREATE INDEX IF NOT EXISTS customer_issues_support_state_idx ON customer_issues ((support_data->>'status'), updated_at DESC) WHERE support_data IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS customer_issues_id_customer_idx ON customer_issues(id, customer_id);
CREATE INDEX IF NOT EXISTS customer_issues_support_active_idx ON customer_issues(customer_id,category,updated_at DESC) WHERE support_data IS NOT NULL AND support_data->>'status' NOT IN ('RESOLVED','CLOSED');
CREATE INDEX IF NOT EXISTS customer_issues_support_incident_idx ON customer_issues ((support_data->>'diagnosis'),created_at) WHERE support_data IS NOT NULL;
CREATE TABLE IF NOT EXISTS support_exceptions (
  id uuid PRIMARY KEY, customer_id uuid NOT NULL REFERENCES customers(id),
  support_case_id uuid NOT NULL REFERENCES customer_issues(id),
  dedup_key text NOT NULL, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (support_case_id,customer_id) REFERENCES customer_issues(id,customer_id),
  CHECK (data->>'status' IN ('OPEN','ACKNOWLEDGED','IN_PROGRESS','WAITING_CUSTOMER','RESOLVED','DISMISSED'))
);
CREATE UNIQUE INDEX IF NOT EXISTS support_exceptions_active_dedup_idx ON support_exceptions(customer_id, dedup_key)
  WHERE data->>'status' NOT IN ('RESOLVED','DISMISSED');
CREATE INDEX IF NOT EXISTS support_exceptions_inbox_idx ON support_exceptions ((data->>'status'), (data->>'severity'), updated_at DESC);
CREATE INDEX IF NOT EXISTS support_exceptions_customer_idx ON support_exceptions(customer_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS support_knowledge (
  id uuid PRIMARY KEY, customer_id uuid REFERENCES customers(id), data jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT support_knowledge_status CHECK (data->>'validation_status' IN ('CANDIDATE','VALIDATED','DEPRECATED','REJECTED'))
);
CREATE INDEX IF NOT EXISTS support_knowledge_lookup_idx ON support_knowledge ((data->>'problem_pattern'), (data->>'validation_status'));
-- Synthetic probes and receipts are local test-provider state, never real integrations.
CREATE TABLE IF NOT EXISTS support_probes (id uuid PRIMARY KEY, customer_id uuid NOT NULL UNIQUE REFERENCES customers(id), data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS support_receipts (id uuid PRIMARY KEY, customer_id uuid NOT NULL REFERENCES customers(id), data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS support_receipts_operation_idx ON support_receipts(customer_id, (data->>'idempotency_key'));
CREATE TABLE IF NOT EXISTS support_incident_candidates (id uuid PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS support_incident_window_idx ON support_incident_candidates ((data->>'window_key'));
