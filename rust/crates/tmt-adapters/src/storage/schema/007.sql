ALTER TABLE request_attempts
  ADD COLUMN originator_kind TEXT NOT NULL DEFAULT 'unknown'
    CHECK (originator_kind IN ('unknown', 'explicit', 'verified'));
ALTER TABLE request_attempts
  ADD COLUMN originator_identity_id TEXT
    CHECK (
      (originator_kind = 'unknown' AND originator_identity_id IS NULL) OR
      (originator_kind IN ('explicit', 'verified') AND originator_identity_id IS NOT NULL)
    );
ALTER TABLE request_attempts
  ADD COLUMN recipient_identity_id TEXT;
ALTER TABLE request_attempts
  ADD COLUMN message_text TEXT;
ALTER TABLE request_attempts
  ADD COLUMN message_bytes INTEGER
    CHECK (message_bytes IS NULL OR message_bytes >= 0);
ALTER TABLE request_attempts
  ADD COLUMN message_expires_at_ms INTEGER;
CREATE INDEX request_attempts_prompt_expiry
  ON request_attempts (message_expires_at_ms, attempt_id)
  WHERE message_text IS NOT NULL;
