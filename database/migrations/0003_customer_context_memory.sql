ALTER TABLE conversation_sessions
  ADD COLUMN IF NOT EXISTS conversation_id uuid,
  ADD COLUMN IF NOT EXISTS customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS channel text,
  ADD COLUMN IF NOT EXISTS context_state text,
  ADD COLUMN IF NOT EXISTS started_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_activity_at timestamptz,
  ADD COLUMN IF NOT EXISTS summary text,
  ADD COLUMN IF NOT EXISTS handoff_status text,
  ADD COLUMN IF NOT EXISTS correlation_id uuid,
  ADD COLUMN IF NOT EXISTS pending_actions jsonb,
  ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversation_sessions_context_state_check'
  ) THEN
    ALTER TABLE conversation_sessions
      ADD CONSTRAINT conversation_sessions_context_state_check
      CHECK (context_state IS NULL OR context_state IN (
        'NEW_CONTACT', 'GENERAL', 'SALES', 'WAITING_PAYMENT', 'RENEWAL',
        'SUPPORT', 'RECOVERY', 'HUMAN_HANDOFF'
      )) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversation_sessions_handoff_status_check'
  ) THEN
    ALTER TABLE conversation_sessions
      ADD CONSTRAINT conversation_sessions_handoff_status_check
      CHECK (handoff_status IS NULL OR handoff_status IN (
        'NONE', 'REQUESTED', 'ASSIGNED', 'RESOLVED'
      )) NOT VALID;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS conversation_sessions_conversation_unique
  ON conversation_sessions (conversation_id)
  WHERE conversation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS conversation_sessions_customer_activity_idx
  ON conversation_sessions (customer_id, last_activity_at DESC)
  WHERE customer_id IS NOT NULL;

ALTER TABLE message_logs
  ADD COLUMN IF NOT EXISTS conversation_id uuid,
  ADD COLUMN IF NOT EXISTS content_type text,
  ADD COLUMN IF NOT EXISTS processing_status text,
  ADD COLUMN IF NOT EXISTS correlation_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'message_logs_content_type_check'
  ) THEN
    ALTER TABLE message_logs
      ADD CONSTRAINT message_logs_content_type_check
      CHECK (content_type IS NULL OR content_type IN (
        'TEXT', 'AUDIO', 'IMAGE', 'DOCUMENT', 'PDF', 'UNKNOWN'
      )) NOT VALID;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS message_logs_customer_created_idx
  ON message_logs (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS message_logs_conversation_created_idx
  ON message_logs (conversation_id, created_at DESC)
  WHERE conversation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS message_logs_correlation_idx
  ON message_logs (correlation_id)
  WHERE correlation_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS customer_memories (
  memory_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  memory_type text NOT NULL CHECK (memory_type IN (
    'IDENTITY_FACT', 'PREFERENCE', 'RELATIONSHIP', 'SUPPORT_FACT',
    'COMMERCIAL_CONTEXT', 'OPERATIONAL_NOTE'
  )),
  memory_key text NOT NULL,
  value jsonb NOT NULL,
  source text NOT NULL,
  source_reference text,
  confidence text NOT NULL CHECK (confidence IN ('HIGH', 'MEDIUM', 'LOW')),
  observed_at timestamptz NOT NULL,
  valid_from timestamptz,
  valid_until timestamptz,
  superseded_by uuid REFERENCES customer_memories(memory_id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN (
    'ACTIVE', 'SUPERSEDED', 'DISPUTED', 'EXPIRED', 'DELETED'
  )),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until > valid_from)
);

CREATE UNIQUE INDEX IF NOT EXISTS customer_memories_active_unique
  ON customer_memories (customer_id, memory_type, memory_key)
  WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS customer_memories_relevant_idx
  ON customer_memories (customer_id, status, observed_at DESC);
CREATE INDEX IF NOT EXISTS customer_memories_validity_idx
  ON customer_memories (customer_id, valid_until)
  WHERE status = 'ACTIVE' AND valid_until IS NOT NULL;

CREATE TABLE IF NOT EXISTS customer_context_snapshots (
  context_snapshot_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  correlation_id uuid NOT NULL,
  purpose text NOT NULL CHECK (purpose IN (
    'CONVERSATION', 'RENEWAL', 'PAYMENT', 'SUPPORT', 'SALES'
  )),
  channel text NOT NULL,
  requested_scopes text[] NOT NULL DEFAULT ARRAY[]::text[],
  selected_scopes text[] NOT NULL DEFAULT ARRAY[]::text[],
  sources jsonb NOT NULL,
  context jsonb NOT NULL,
  freshness jsonb NOT NULL,
  selected_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  excluded_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  exclusion_reason_codes text[] NOT NULL DEFAULT ARRAY[]::text[],
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS customer_context_snapshots_customer_created_idx
  ON customer_context_snapshots (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS customer_context_snapshots_correlation_idx
  ON customer_context_snapshots (correlation_id);

CREATE OR REPLACE FUNCTION reject_customer_context_snapshot_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Customer context snapshots are immutable';
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'customer_context_snapshots_immutable'
       AND tgrelid = 'customer_context_snapshots'::regclass
  ) THEN
    CREATE TRIGGER customer_context_snapshots_immutable
    BEFORE UPDATE ON customer_context_snapshots
    FOR EACH ROW EXECUTE FUNCTION reject_customer_context_snapshot_update();
  END IF;
END $$;

ALTER TABLE ai_messages
  ADD COLUMN IF NOT EXISTS context_snapshot_id uuid
    REFERENCES customer_context_snapshots(context_snapshot_id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS correlation_id uuid;

CREATE INDEX IF NOT EXISTS ai_messages_context_snapshot_idx
  ON ai_messages (context_snapshot_id)
  WHERE context_snapshot_id IS NOT NULL;
