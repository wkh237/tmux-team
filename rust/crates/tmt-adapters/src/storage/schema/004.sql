CREATE TABLE preamble_counters (
  identity_id TEXT PRIMARY KEY REFERENCES identities(id) ON DELETE CASCADE,
  reserved_count INTEGER NOT NULL CHECK (reserved_count >= 0),
  updated_at_ms INTEGER NOT NULL
);
CREATE TABLE request_attempts (
  attempt_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  nonce TEXT,
  identity_id TEXT REFERENCES identities(id) ON DELETE SET NULL,
  server_id TEXT NOT NULL,
  socket_path TEXT NOT NULL,
  server_pid INTEGER NOT NULL CHECK (server_pid > 0),
  server_start_time TEXT NOT NULL,
  pane_id TEXT NOT NULL,
  pane_pid INTEGER NOT NULL CHECK (pane_pid > 0),
  wait_active INTEGER NOT NULL CHECK (wait_active IN (0, 1)),
  status TEXT NOT NULL CHECK (
    status IN ('prepared', 'sending', 'sent', 'uncertain', 'definitely_failed')
  ),
  preamble_every INTEGER CHECK (preamble_every IS NULL OR preamble_every > 0),
  inject_preamble INTEGER NOT NULL CHECK (inject_preamble IN (0, 1)),
  cadence_reserved INTEGER NOT NULL CHECK (cadence_reserved IN (0, 1)),
  prepared_at_ms INTEGER NOT NULL,
  sending_at_ms INTEGER,
  settled_at_ms INTEGER,
  wait_released_at_ms INTEGER,
  expires_at_ms INTEGER NOT NULL
);
CREATE INDEX request_attempts_endpoint_active
  ON request_attempts (
    server_id, socket_path, server_pid, server_start_time, pane_id, pane_pid,
    wait_active, status, prepared_at_ms
  );
CREATE INDEX request_attempts_retention
  ON request_attempts (wait_active, status, settled_at_ms);
CREATE INDEX request_attempts_expiry
  ON request_attempts (expires_at_ms, status);
