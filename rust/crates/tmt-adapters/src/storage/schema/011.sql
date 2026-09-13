CREATE TABLE office_local_worlds (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  id TEXT NOT NULL UNIQUE CHECK (length(id) = 36),
  created_at_ms INTEGER NOT NULL CHECK (
    typeof(created_at_ms) = 'integer' AND
    created_at_ms > 0 AND created_at_ms <= 9007199254740991
  )
);

CREATE TABLE office_local_blocks (
  block_id TEXT PRIMARY KEY CHECK (length(block_id) = 36),
  identity_id TEXT NOT NULL UNIQUE REFERENCES identities(id),
  revision INTEGER NOT NULL CHECK (
    typeof(revision) = 'integer' AND
    revision BETWEEN 1 AND 9007199254740991
  ),
  layout TEXT NOT NULL CHECK (length(layout) <= 4096),
  updated_at_ms INTEGER NOT NULL CHECK (
    typeof(updated_at_ms) = 'integer' AND
    updated_at_ms > 0 AND updated_at_ms <= 9007199254740991
  )
);

CREATE INDEX office_local_blocks_active_projection ON office_local_blocks (identity_id, block_id);
