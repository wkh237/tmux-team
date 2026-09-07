ALTER TABLE request_attempts
  ADD COLUMN retention_days INTEGER NOT NULL DEFAULT 7;
ALTER TABLE request_attempts
  ADD COLUMN retention_expires_at_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE request_responses
  ADD COLUMN response_expires_at_ms INTEGER NOT NULL DEFAULT 0;
