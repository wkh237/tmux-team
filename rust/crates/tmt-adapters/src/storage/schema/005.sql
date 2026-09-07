ALTER TABLE request_attempts
  ADD COLUMN response_submitted_at_ms INTEGER;
CREATE TABLE request_responses (
  request_id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL,
  server_id TEXT NOT NULL,
  socket_path TEXT NOT NULL,
  server_pid INTEGER NOT NULL CHECK (server_pid > 0),
  server_start_time TEXT NOT NULL,
  pane_id TEXT NOT NULL,
  pane_pid INTEGER NOT NULL CHECK (pane_pid > 0),
  body TEXT NOT NULL,
  body_bytes INTEGER NOT NULL CHECK (body_bytes >= 0),
  submitted_at_ms INTEGER NOT NULL CHECK (submitted_at_ms > 0)
);
CREATE INDEX request_responses_retention
  ON request_responses (submitted_at_ms);
