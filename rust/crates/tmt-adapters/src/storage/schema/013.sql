CREATE TABLE identity_metadata (
  identity_id TEXT NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (identity_id, key)
) WITHOUT ROWID;

CREATE INDEX identity_metadata_search
  ON identity_metadata (key, value, identity_id);
