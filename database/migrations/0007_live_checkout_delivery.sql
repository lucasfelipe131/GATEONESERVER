-- Durable reservations precede external calls; an uncertain response requires
-- recovery by reference or human review, never another blind provider mutation.
CREATE TABLE live_checkout_operations (
  charge_id uuid PRIMARY KEY REFERENCES charges(id) ON DELETE RESTRICT,
  state text NOT NULL CHECK (state IN ('RESERVED','CREATING','READY','REVIEW')),
  correlation_id uuid NOT NULL,
  preference_id text,
  checkout_url text,
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE notification_requests
  ADD COLUMN delivery_state text NOT NULL DEFAULT 'PENDING'
    CHECK (delivery_state IN ('PENDING','SENDING','SENT','REVIEW','CANCELLED')),
  ADD COLUMN provider_message_id text,
  ADD COLUMN delivery_error text;
