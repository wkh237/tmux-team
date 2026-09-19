-- Allow bounded per-placement tint and display text without losing local layouts.
ALTER TABLE office_local_blocks RENAME TO office_local_blocks_previous;
DROP INDEX office_local_blocks_active_projection;
DROP INDEX office_local_blocks_single_lobby;

CREATE TABLE office_local_blocks (
  block_id TEXT PRIMARY KEY CHECK (length(block_id) = 36),
  target_kind TEXT NOT NULL DEFAULT 'identity' CHECK (target_kind IN ('identity', 'lobby')),
  identity_id TEXT UNIQUE REFERENCES identities(id),
  revision INTEGER NOT NULL CHECK (
    typeof(revision) = 'integer' AND revision BETWEEN 1 AND 9007199254740991
  ),
  layout TEXT NOT NULL CHECK (length(CAST(layout AS BLOB)) <= 8192),
  updated_at_ms INTEGER NOT NULL CHECK (
    typeof(updated_at_ms) = 'integer' AND
    updated_at_ms > 0 AND updated_at_ms <= 9007199254740991
  ),
  CHECK ((target_kind = 'identity' AND identity_id IS NOT NULL) OR
         (target_kind = 'lobby' AND identity_id IS NULL))
);

INSERT INTO office_local_blocks SELECT * FROM office_local_blocks_previous;
DROP TABLE office_local_blocks_previous;
CREATE UNIQUE INDEX office_local_blocks_single_lobby
  ON office_local_blocks (target_kind) WHERE target_kind = 'lobby';
CREATE INDEX office_local_blocks_active_projection ON office_local_blocks (identity_id, block_id);
