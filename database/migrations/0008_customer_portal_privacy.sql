ALTER TABLE customers ADD COLUMN IF NOT EXISTS portal_token_expires_at timestamptz;
-- Legacy links get a finite transition period. New links are single use.
UPDATE customers SET portal_token_expires_at = now() + interval '24 hours'
 WHERE portal_token_hash IS NOT NULL AND portal_token_expires_at IS NULL;

CREATE TABLE IF NOT EXISTS customer_portal_links (
  token_hash text PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  whatsapp_e164 text NOT NULL,
  request_key text NOT NULL,
  token_encrypted text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, request_key)
);
CREATE INDEX IF NOT EXISTS customer_portal_links_expiry_idx ON customer_portal_links (expires_at);

CREATE TABLE IF NOT EXISTS customer_portal_sessions (
  token_hash text PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  whatsapp_e164 text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS customer_portal_sessions_customer_idx ON customer_portal_sessions (customer_id, expires_at);

CREATE TABLE IF NOT EXISTS customer_privacy_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN ('NOTICE_ACKNOWLEDGED', 'CONTACT_GRANTED', 'CONTACT_WITHDRAWN')),
  notice_version text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('PORTAL', 'WHATSAPP')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS customer_privacy_events_customer_idx ON customer_privacy_events (customer_id, created_at DESC);

CREATE TABLE IF NOT EXISTS customer_privacy_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  request_key uuid NOT NULL,
  request_type text NOT NULL CHECK (request_type IN ('ACCESS', 'CORRECTION', 'ERASURE')),
  handoff_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, request_key)
);
CREATE INDEX IF NOT EXISTS customer_privacy_requests_customer_idx ON customer_privacy_requests (customer_id, created_at DESC);
