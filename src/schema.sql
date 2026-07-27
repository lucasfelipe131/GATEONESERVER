CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  email text NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL DEFAULT 'admin' CHECK (role IN ('admin', 'operator')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_unique ON users (lower(email));

CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  duration_months integer NOT NULL CHECK (duration_months > 0),
  price_cents integer NOT NULL CHECK (price_cents > 0),
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE plans ADD COLUMN IF NOT EXISTS description text;

CREATE TABLE IF NOT EXISTS customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  whatsapp_e164 text NOT NULL,
  email text,
  bitpanel_reference text,
  bitpanel_owner text,
  automation_eligible boolean NOT NULL DEFAULT true,
  source text NOT NULL DEFAULT 'manual',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('lead', 'active', 'late', 'suspended', 'cancelled')),
  operational_stage text NOT NULL DEFAULT 'ready' CHECK (operational_stage IN ('ready', 'create_login', 'awaiting_payment', 'review')),
  consent_contact boolean NOT NULL DEFAULT false,
  opt_out_at timestamptz,
  portal_token_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS customers_whatsapp_unique ON customers (whatsapp_e164);
CREATE UNIQUE INDEX IF NOT EXISTS customers_portal_token_unique
  ON customers (portal_token_hash) WHERE portal_token_hash IS NOT NULL;
ALTER TABLE customers ALTER COLUMN name DROP NOT NULL;
ALTER TABLE customers ALTER COLUMN whatsapp_e164 DROP NOT NULL;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS bitpanel_owner text;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS automation_eligible boolean NOT NULL DEFAULT true;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS operational_stage text NOT NULL DEFAULT 'ready';
ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_operational_stage_check;
ALTER TABLE customers ADD CONSTRAINT customers_operational_stage_check
  CHECK (operational_stage IN ('ready', 'create_login', 'awaiting_payment', 'review'));

CREATE TABLE IF NOT EXISTS subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  plan_id uuid NOT NULL REFERENCES plans(id),
  starts_on date NOT NULL DEFAULT CURRENT_DATE,
  expires_on date NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('pending', 'active', 'late', 'suspended', 'cancelled')),
  auto_renew boolean NOT NULL DEFAULT false,
  bitpanel_list_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS subscriptions_expiry_idx ON subscriptions (expires_on, status);

CREATE TABLE IF NOT EXISTS charges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  plan_id uuid REFERENCES plans(id),
  stage text NOT NULL CHECK (stage IN ('new_sale', 'd-3', 'd0', 'd+2', 'd+5', 'manual')),
  status text NOT NULL DEFAULT 'awaiting_approval'
    CHECK (status IN ('draft', 'awaiting_approval', 'approved', 'sent', 'paid', 'rejected', 'cancelled', 'expired')),
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  due_on date NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  message_text text NOT NULL,
  content_version integer NOT NULL DEFAULT 1,
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  mercado_pago_payment_id text,
  mercado_pago_preference_id text,
  checkout_url text,
  pix_copy_paste text,
  pix_ticket_url text,
  pix_expires_at timestamptz,
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE charges ADD COLUMN IF NOT EXISTS plan_id uuid REFERENCES plans(id);
ALTER TABLE charges ADD COLUMN IF NOT EXISTS mercado_pago_preference_id text;
ALTER TABLE charges ADD COLUMN IF NOT EXISTS checkout_url text;
CREATE INDEX IF NOT EXISTS charges_status_idx ON charges (status, due_on);

CREATE TABLE IF NOT EXISTS message_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  charge_id uuid REFERENCES charges(id) ON DELETE SET NULL,
  direction text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  channel text NOT NULL DEFAULT 'whatsapp',
  template_name text,
  content text,
  provider_id text,
  status text NOT NULL DEFAULT 'queued',
  simulated boolean NOT NULL DEFAULT false,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS renewal_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  charge_id uuid NOT NULL UNIQUE REFERENCES charges(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'awaiting_approval'
    CHECK (status IN ('awaiting_approval', 'queued', 'running', 'completed', 'failed', 'manual_review', 'cancelled', 'simulated')),
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  before_expiry text,
  after_expiry text,
  evidence_path text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text,
  whatsapp_e164 text,
  source text NOT NULL DEFAULT 'landing_page',
  campaign text,
  desired_plan text,
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'engaged', 'payment_pending', 'converted', 'lost', 'opted_out')),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS leads_status_idx ON leads (status, created_at DESC);

CREATE TABLE IF NOT EXISTS conversation_sessions (
  whatsapp_e164 text PRIMARY KEY,
  state text NOT NULL DEFAULT 'menu',
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS loyalty_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  points integer NOT NULL,
  reason text NOT NULL,
  reference_type text,
  reference_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  provider_event_id text NOT NULL,
  event_type text,
  payload jsonb NOT NULL,
  processed_at timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_event_id)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id bigserial PRIMARY KEY,
  actor_type text NOT NULL,
  actor_id text,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  before_data jsonb,
  after_data jsonb,
  ip text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS system_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS integration_credentials (
  provider text PRIMARY KEY,
  encrypted_value text NOT NULL,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE integration_credentials
  DROP CONSTRAINT IF EXISTS integration_credentials_provider_check;
ALTER TABLE integration_credentials
  ADD CONSTRAINT integration_credentials_provider_check
  CHECK (provider IN ('mercadopago', 'whatsapp', 'bitpanel', 'openai'));

CREATE TABLE IF NOT EXISTS ai_messages (
  id bigserial PRIMARY KEY,
  audience text NOT NULL CHECK (audience IN ('admin', 'customer')),
  customer_id uuid REFERENCES customers(id) ON DELETE CASCADE,
  actor_id text,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL,
  model text,
  provider_response_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_messages_audience_created_idx
  ON ai_messages (audience, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_messages_customer_created_idx
  ON ai_messages (customer_id, created_at DESC)
  WHERE customer_id IS NOT NULL;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  email text NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL DEFAULT 'admin' CHECK (role IN ('admin', 'operator')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_unique ON users (lower(email));

CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  duration_months integer NOT NULL CHECK (duration_months > 0),
  price_cents integer NOT NULL CHECK (price_cents > 0),
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE plans ADD COLUMN IF NOT EXISTS description text;

CREATE TABLE IF NOT EXISTS customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  whatsapp_e164 text NOT NULL,
  email text,
  bitpanel_reference text,
  bitpanel_owner text,
  automation_eligible boolean NOT NULL DEFAULT true,
  source text NOT NULL DEFAULT 'manual',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('lead', 'active', 'late', 'suspended', 'cancelled')),
  consent_contact boolean NOT NULL DEFAULT false,
  opt_out_at timestamptz,
  portal_token_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS customers_whatsapp_unique ON customers (whatsapp_e164);
CREATE UNIQUE INDEX IF NOT EXISTS customers_portal_token_unique
  ON customers (portal_token_hash) WHERE portal_token_hash IS NOT NULL;
ALTER TABLE customers ALTER COLUMN name DROP NOT NULL;
ALTER TABLE customers ALTER COLUMN whatsapp_e164 DROP NOT NULL;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS bitpanel_owner text;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS automation_eligible boolean NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  plan_id uuid NOT NULL REFERENCES plans(id),
  starts_on date NOT NULL DEFAULT CURRENT_DATE,
  expires_on date NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('pending', 'active', 'late', 'suspended', 'cancelled')),
  auto_renew boolean NOT NULL DEFAULT false,
  bitpanel_list_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS subscriptions_expiry_idx ON subscriptions (expires_on, status);

CREATE TABLE IF NOT EXISTS charges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  plan_id uuid REFERENCES plans(id),
  stage text NOT NULL CHECK (stage IN ('new_sale', 'd-3', 'd0', 'd+2', 'd+5', 'manual')),
  status text NOT NULL DEFAULT 'awaiting_approval'
    CHECK (status IN ('draft', 'awaiting_approval', 'approved', 'sent', 'paid', 'rejected', 'cancelled', 'expired')),
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  due_on date NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  message_text text NOT NULL,
  content_version integer NOT NULL DEFAULT 1,
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  mercado_pago_payment_id text,
  mercado_pago_preference_id text,
  checkout_url text,
  pix_copy_paste text,
  pix_ticket_url text,
  pix_expires_at timestamptz,
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE charges ADD COLUMN IF NOT EXISTS plan_id uuid REFERENCES plans(id);
ALTER TABLE charges ADD COLUMN IF NOT EXISTS mercado_pago_preference_id text;
ALTER TABLE charges ADD COLUMN IF NOT EXISTS checkout_url text;
CREATE INDEX IF NOT EXISTS charges_status_idx ON charges (status, due_on);

CREATE TABLE IF NOT EXISTS message_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  charge_id uuid REFERENCES charges(id) ON DELETE SET NULL,
  direction text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  channel text NOT NULL DEFAULT 'whatsapp',
  template_name text,
  content text,
  provider_id text,
  status text NOT NULL DEFAULT 'queued',
  simulated boolean NOT NULL DEFAULT false,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS renewal_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  charge_id uuid NOT NULL UNIQUE REFERENCES charges(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'awaiting_approval'
    CHECK (status IN ('awaiting_approval', 'queued', 'running', 'completed', 'failed', 'manual_review', 'cancelled', 'simulated')),
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  before_expiry text,
  after_expiry text,
  evidence_path text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text,
  whatsapp_e164 text,
  source text NOT NULL DEFAULT 'landing_page',
  campaign text,
  desired_plan text,
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'engaged', 'payment_pending', 'converted', 'lost', 'opted_out')),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS leads_status_idx ON leads (status, created_at DESC);

CREATE TABLE IF NOT EXISTS conversation_sessions (
  whatsapp_e164 text PRIMARY KEY,
  state text NOT NULL DEFAULT 'menu',
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS loyalty_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  points integer NOT NULL,
  reason text NOT NULL,
  reference_type text,
  reference_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  provider_event_id text NOT NULL,
  event_type text,
  payload jsonb NOT NULL,
  processed_at timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_event_id)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id bigserial PRIMARY KEY,
  actor_type text NOT NULL,
  actor_id text,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  before_data jsonb,
  after_data jsonb,
  ip text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS system_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS integration_credentials (
  provider text PRIMARY KEY,
  encrypted_value text NOT NULL,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE integration_credentials
  DROP CONSTRAINT IF EXISTS integration_credentials_provider_check;
ALTER TABLE integration_credentials
  ADD CONSTRAINT integration_credentials_provider_check
  CHECK (provider IN ('mercadopago', 'whatsapp', 'bitpanel', 'openai'));

CREATE TABLE IF NOT EXISTS ai_messages (
  id bigserial PRIMARY KEY,
  audience text NOT NULL CHECK (audience IN ('admin', 'customer')),
  customer_id uuid REFERENCES customers(id) ON DELETE CASCADE,
  actor_id text,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL,
  model text,
  provider_response_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_messages_audience_created_idx
  ON ai_messages (audience, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_messages_customer_created_idx
  ON ai_messages (customer_id, created_at DESC)
  WHERE customer_id IS NOT NULL;
