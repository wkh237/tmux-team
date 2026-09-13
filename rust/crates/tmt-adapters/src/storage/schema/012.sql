ALTER TABLE request_attempts RENAME TO request_attempts_v11;

CREATE TABLE request_attempts (
  attempt_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  nonce TEXT,
  identity_id TEXT REFERENCES identities(id) ON DELETE SET NULL,
  route_kind TEXT NOT NULL DEFAULT 'pane' CHECK (route_kind IN ('pane', 'inbox')),
  server_id TEXT,
  socket_path TEXT,
  server_pid INTEGER CHECK (server_pid IS NULL OR server_pid > 0),
  server_start_time TEXT,
  pane_id TEXT,
  pane_pid INTEGER CHECK (pane_pid IS NULL OR pane_pid > 0),
  wait_active INTEGER NOT NULL CHECK (wait_active IN (0, 1)),
  status TEXT NOT NULL CHECK (
    status IN ('prepared', 'sending', 'sent', 'queued', 'uncertain', 'definitely_failed')
  ),
  preamble_every INTEGER CHECK (preamble_every IS NULL OR preamble_every > 0),
  inject_preamble INTEGER NOT NULL CHECK (inject_preamble IN (0, 1)),
  cadence_reserved INTEGER NOT NULL CHECK (cadence_reserved IN (0, 1)),
  prepared_at_ms INTEGER NOT NULL,
  sending_at_ms INTEGER,
  settled_at_ms INTEGER,
  wait_released_at_ms INTEGER,
  expires_at_ms INTEGER NOT NULL,
  response_submitted_at_ms INTEGER,
  retention_days INTEGER NOT NULL DEFAULT 7,
  retention_expires_at_ms INTEGER NOT NULL DEFAULT 0,
  originator_kind TEXT NOT NULL DEFAULT 'unknown' CHECK (originator_kind IN ('unknown', 'explicit', 'verified')),
  originator_identity_id TEXT CHECK (
    (originator_kind = 'unknown' AND originator_identity_id IS NULL) OR
    (originator_kind IN ('explicit', 'verified') AND originator_identity_id IS NOT NULL)
  ),
  recipient_identity_id TEXT,
  message_text TEXT,
  message_bytes INTEGER CHECK (message_bytes IS NULL OR message_bytes >= 0),
  message_expires_at_ms INTEGER,
  attention_revision INTEGER NOT NULL DEFAULT 0 CHECK (
    typeof(attention_revision) = 'integer' AND
    attention_revision BETWEEN 0 AND 9007199254740991
  ),
  attention_acknowledged_revision INTEGER NOT NULL DEFAULT 0 CHECK (
    typeof(attention_acknowledged_revision) = 'integer' AND
    attention_acknowledged_revision BETWEEN 0 AND attention_revision
  ),
  recipient_attention_revision INTEGER NOT NULL DEFAULT 0 CHECK (
    typeof(recipient_attention_revision) = 'integer' AND
    recipient_attention_revision BETWEEN 0 AND 9007199254740991
  ),
  recipient_attention_acknowledged_revision INTEGER NOT NULL DEFAULT 0 CHECK (
    typeof(recipient_attention_acknowledged_revision) = 'integer' AND
    recipient_attention_acknowledged_revision BETWEEN 0 AND recipient_attention_revision
  ),
  CHECK (
    (route_kind = 'pane' AND server_id IS NOT NULL AND socket_path IS NOT NULL AND
      server_pid IS NOT NULL AND server_start_time IS NOT NULL AND pane_id IS NOT NULL AND
      pane_pid IS NOT NULL) OR
    (route_kind = 'inbox' AND recipient_identity_id IS NOT NULL AND
      server_id IS NULL AND socket_path IS NULL AND server_pid IS NULL AND
      server_start_time IS NULL AND pane_id IS NULL AND pane_pid IS NULL)
  )
);

INSERT INTO request_attempts (
  attempt_id, request_id, nonce, identity_id, route_kind, server_id, socket_path,
  server_pid, server_start_time, pane_id, pane_pid, wait_active, status,
  preamble_every, inject_preamble, cadence_reserved, prepared_at_ms,
  sending_at_ms, settled_at_ms, wait_released_at_ms, expires_at_ms,
  response_submitted_at_ms, retention_days, retention_expires_at_ms,
  originator_kind, originator_identity_id, recipient_identity_id, message_text,
  message_bytes, message_expires_at_ms, attention_revision,
  attention_acknowledged_revision
)
SELECT
  attempt_id, request_id, nonce, identity_id, 'pane', server_id, socket_path,
  server_pid, server_start_time, pane_id, pane_pid, wait_active, status,
  preamble_every, inject_preamble, cadence_reserved, prepared_at_ms,
  sending_at_ms, settled_at_ms, wait_released_at_ms, expires_at_ms,
  response_submitted_at_ms, retention_days, retention_expires_at_ms,
  originator_kind, originator_identity_id, recipient_identity_id, message_text,
  message_bytes, message_expires_at_ms, attention_revision,
  attention_acknowledged_revision
FROM request_attempts_v11;

DROP TABLE request_attempts_v11;

CREATE INDEX request_attempts_endpoint_active ON request_attempts (
  server_id, socket_path, server_pid, server_start_time, pane_id, pane_pid,
  wait_active, status, prepared_at_ms
) WHERE route_kind = 'pane';
CREATE INDEX request_attempts_retention ON request_attempts (wait_active, status, settled_at_ms);
CREATE INDEX request_attempts_expiry ON request_attempts (expires_at_ms, status);
CREATE INDEX request_attempts_retention_horizon ON request_attempts (retention_expires_at_ms, attempt_id);
CREATE INDEX request_attempts_cleanup_expiry ON request_attempts (expires_at_ms, attempt_id)
  WHERE wait_active = 1 OR status IN ('prepared', 'sending');
CREATE INDEX request_attempts_prompt_expiry ON request_attempts (message_expires_at_ms, attempt_id)
  WHERE message_text IS NOT NULL;
CREATE INDEX request_attempts_attention ON request_attempts (originator_identity_id, attention_revision, request_id);
CREATE INDEX request_attempts_response_attention ON request_attempts (
  originator_identity_id, attention_revision, request_id
) WHERE response_submitted_at_ms IS NOT NULL;
CREATE INDEX request_attempts_recipient_attention ON request_attempts (
  recipient_identity_id, status, recipient_attention_revision, request_id
) WHERE route_kind = 'inbox';

CREATE TABLE request_recipient_attention_identities (
  identity_id TEXT PRIMARY KEY,
  latest_revision INTEGER NOT NULL CHECK (
    typeof(latest_revision) = 'integer' AND latest_revision BETWEEN 0 AND 9007199254740991
  ),
  acknowledged_through INTEGER NOT NULL CHECK (
    typeof(acknowledged_through) = 'integer' AND
    acknowledged_through BETWEEN 0 AND latest_revision
  )
);

ALTER TABLE request_responses RENAME TO request_responses_v11;

CREATE TABLE request_responses (
  request_id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL,
  route_kind TEXT NOT NULL DEFAULT 'pane' CHECK (route_kind IN ('pane', 'inbox')),
  route_recipient_identity_id TEXT,
  server_id TEXT,
  socket_path TEXT,
  server_pid INTEGER CHECK (server_pid IS NULL OR server_pid > 0),
  server_start_time TEXT,
  pane_id TEXT,
  pane_pid INTEGER CHECK (pane_pid IS NULL OR pane_pid > 0),
  body TEXT NOT NULL,
  body_bytes INTEGER NOT NULL CHECK (body_bytes >= 0),
  submitted_at_ms INTEGER NOT NULL CHECK (submitted_at_ms > 0),
  response_expires_at_ms INTEGER NOT NULL DEFAULT 0,
  CHECK (
    (route_kind = 'pane' AND route_recipient_identity_id IS NULL AND
      server_id IS NOT NULL AND socket_path IS NOT NULL AND server_pid IS NOT NULL AND
      server_start_time IS NOT NULL AND pane_id IS NOT NULL AND pane_pid IS NOT NULL) OR
    (route_kind = 'inbox' AND route_recipient_identity_id IS NOT NULL AND
      server_id IS NULL AND socket_path IS NULL AND server_pid IS NULL AND
      server_start_time IS NULL AND pane_id IS NULL AND pane_pid IS NULL)
  )
);

INSERT INTO request_responses (
  request_id, attempt_id, route_kind, server_id, socket_path, server_pid,
  server_start_time, pane_id, pane_pid, body, body_bytes, submitted_at_ms,
  response_expires_at_ms
)
SELECT
  request_id, attempt_id, 'pane', server_id, socket_path, server_pid,
  server_start_time, pane_id, pane_pid, body, body_bytes, submitted_at_ms,
  response_expires_at_ms
FROM request_responses_v11;

DROP TABLE request_responses_v11;

CREATE INDEX request_responses_retention ON request_responses (submitted_at_ms);
CREATE INDEX request_responses_expiry ON request_responses (response_expires_at_ms, request_id);
CREATE INDEX request_responses_attempt ON request_responses (attempt_id, response_expires_at_ms);
