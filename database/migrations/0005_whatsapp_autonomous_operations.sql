-- PASSO 05: EXPAND-only. Agent state is additive and does not rewrite legacy conversations.

CREATE TABLE IF NOT EXISTS agent_decisions (
  decision_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id text NOT NULL,
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  context_snapshot_id uuid REFERENCES customer_context_snapshots(context_snapshot_id) ON DELETE SET NULL,
  message_id text NOT NULL,
  correlation_id uuid NOT NULL,
  intents jsonb NOT NULL DEFAULT '[]'::jsonb,
  confidence text NOT NULL CHECK (confidence IN ('HIGH', 'MEDIUM', 'LOW')),
  proposed_action text,
  policy_result text NOT NULL CHECK (policy_result IN (
    'ALLOW', 'DENY', 'REQUIRE_CONFIRMATION', 'REQUIRE_HUMAN'
  )),
  response_status text NOT NULL CHECK (response_status IN (
    'VALIDATED', 'SAFE_FALLBACK', 'FAILED'
  )),
  response_facts jsonb NOT NULL DEFAULT '{}'::jsonb,
  response_text text NOT NULL,
  outcome text NOT NULL,
  prompt_version text NOT NULL,
  autonomous boolean NOT NULL DEFAULT false,
  eligible_for_automation boolean NOT NULL DEFAULT false,
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_decisions_customer_created_idx
  ON agent_decisions (customer_id, created_at DESC)
  WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS agent_decisions_conversation_created_idx
  ON agent_decisions (conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_decisions_correlation_idx
  ON agent_decisions (correlation_id);
CREATE INDEX IF NOT EXISTS agent_decisions_outcome_idx
  ON agent_decisions (eligible_for_automation, autonomous, outcome, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_tool_executions (
  execution_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_id uuid NOT NULL REFERENCES agent_decisions(decision_id) ON DELETE CASCADE,
  sequence integer NOT NULL CHECK (sequence > 0),
  tool_name text NOT NULL,
  capability text,
  risk_level text CHECK (risk_level IS NULL OR risk_level IN ('LOW', 'MEDIUM', 'HIGH')),
  policy_result text NOT NULL CHECK (policy_result IN (
    'ALLOW', 'DENY', 'REQUIRE_CONFIRMATION', 'REQUIRE_HUMAN'
  )),
  status text NOT NULL CHECK (status IN ('SUCCESS', 'FAILED', 'DENIED')),
  attempt integer NOT NULL DEFAULT 1 CHECK (attempt > 0),
  input_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  result_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_code text,
  duration_ms integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (decision_id, sequence)
);

CREATE INDEX IF NOT EXISTS agent_tool_executions_tool_status_idx
  ON agent_tool_executions (tool_name, status, created_at DESC);

CREATE TABLE IF NOT EXISTS conversation_handoffs (
  handoff_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id text NOT NULL,
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  context_snapshot_id uuid REFERENCES customer_context_snapshots(context_snapshot_id) ON DELETE SET NULL,
  correlation_id uuid NOT NULL,
  reason text NOT NULL,
  intent jsonb,
  tools_used jsonb NOT NULL DEFAULT '[]'::jsonb,
  summary text,
  requested_by jsonb NOT NULL,
  status text NOT NULL DEFAULT 'REQUESTED' CHECK (status IN (
    'REQUESTED', 'ASSIGNED', 'RESOLVED', 'CANCELLED'
  )),
  idempotency_key text NOT NULL UNIQUE,
  requested_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

CREATE INDEX IF NOT EXISTS conversation_handoffs_status_idx
  ON conversation_handoffs (status, requested_at);
CREATE INDEX IF NOT EXISTS conversation_handoffs_customer_idx
  ON conversation_handoffs (customer_id, requested_at DESC)
  WHERE customer_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS conversation_turn_leases (
  conversation_key text PRIMARY KEY,
  claim_token uuid NOT NULL,
  message_id text NOT NULL,
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  claim_until timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS conversation_turn_leases_expiry_idx
  ON conversation_turn_leases (claim_until);

CREATE TABLE IF NOT EXISTS agent_memory_candidates (
  candidate_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  conversation_id text NOT NULL,
  decision_id uuid REFERENCES agent_decisions(decision_id) ON DELETE SET NULL,
  memory_type text NOT NULL CHECK (memory_type IN (
    'PREFERENCE', 'RELATIONSHIP', 'SUPPORT_FACT', 'COMMERCIAL_CONTEXT'
  )),
  memory_key text NOT NULL,
  candidate_value jsonb NOT NULL,
  status text NOT NULL DEFAULT 'CANDIDATE' CHECK (status IN (
    'CANDIDATE', 'APPROVED', 'DISCARDED'
  )),
  validation_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  validated_at timestamptz
);

CREATE INDEX IF NOT EXISTS agent_memory_candidates_review_idx
  ON agent_memory_candidates (status, created_at)
  WHERE status = 'CANDIDATE';
