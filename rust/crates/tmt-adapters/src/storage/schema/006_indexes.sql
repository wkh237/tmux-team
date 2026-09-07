CREATE INDEX request_attempts_retention_horizon
  ON request_attempts (retention_expires_at_ms, attempt_id);
CREATE INDEX request_attempts_cleanup_expiry
  ON request_attempts (expires_at_ms, attempt_id)
  WHERE wait_active = 1 OR status IN ('prepared', 'sending');
CREATE INDEX request_responses_expiry
  ON request_responses (response_expires_at_ms, request_id);
CREATE INDEX request_responses_attempt
  ON request_responses (attempt_id, response_expires_at_ms);
