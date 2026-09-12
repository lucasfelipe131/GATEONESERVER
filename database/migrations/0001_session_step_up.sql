ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS step_up_until timestamptz,
  ADD COLUMN IF NOT EXISTS step_up_capability text;
