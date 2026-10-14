-- Read-only provider observations. Passwords stay in the existing encrypted field.
CREATE TABLE IF NOT EXISTS customer_access_sync (
  customer_id uuid PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  subscription_id uuid REFERENCES subscriptions(id) ON DELETE SET NULL,
  list_id text,
  username text,
  owner text,
  verified_whatsapp_e164 text,
  source_url text,
  verified_at timestamptz,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL CHECK (status IN ('READY', 'STALE', 'REAUTH_REQUIRED', 'UNVERIFIED_LINK')),
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS customer_access_sync_attempt_idx
  ON customer_access_sync (attempted_at, customer_id);
-- One bounded reader across worker replicas. This lease never enables actuators.
CREATE TABLE IF NOT EXISTS customer_access_sync_lease (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  holder uuid NOT NULL,
  expires_at timestamptz NOT NULL
);
INSERT INTO system_settings (key,value)
VALUES ('bitpanel_read_sync_enabled','false'::jsonb)
ON CONFLICT (key) DO NOTHING;
