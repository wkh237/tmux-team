-- Advisory pane notification state belongs to the durable inbox attempt.
-- A claimed wake is intentionally not retried after a process crash: pane input
-- may already have happened while the inbox request remains queued.
ALTER TABLE request_attempts ADD COLUMN wake_state TEXT NOT NULL DEFAULT 'not_attempted'
  CHECK (wake_state IN ('not_attempted', 'claimed', 'sent', 'unavailable', 'uncertain'));
