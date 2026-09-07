CREATE TABLE identities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  canonical_name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE bindings (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  transport TEXT NOT NULL CHECK (transport = 'tmux'),
  pane_id TEXT NOT NULL,
  server_id TEXT NOT NULL,
  socket_path TEXT NOT NULL,
  server_pid INTEGER NOT NULL,
  server_start_time TEXT NOT NULL,
  pane_pid INTEGER NOT NULL,
  bound_at TEXT NOT NULL,
  last_verified_at TEXT NOT NULL,
  UNIQUE(identity_id),
  UNIQUE(transport, server_id, pane_id)
);
CREATE INDEX bindings_endpoint ON bindings(transport, server_id, pane_id);
