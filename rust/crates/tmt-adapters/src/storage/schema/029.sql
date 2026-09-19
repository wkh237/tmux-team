-- Self-reported activity is independent of Office appearance, endpoint and request state.
CREATE TABLE identity_status (
  identity_id TEXT PRIMARY KEY REFERENCES identities(id) ON DELETE CASCADE,
  activity TEXT NOT NULL CHECK (length(CAST(activity AS BLOB)) BETWEEN 1 AND 160),
  mood TEXT CHECK (mood IS NULL OR length(CAST(mood AS BLOB)) BETWEEN 1 AND 32),
  updated_at_ms INTEGER NOT NULL CHECK (typeof(updated_at_ms) = 'integer' AND updated_at_ms BETWEEN 1 AND 9007199254740991),
  expires_at_ms INTEGER NOT NULL CHECK (typeof(expires_at_ms) = 'integer' AND expires_at_ms BETWEEN 1 AND 9007199254740991),
  CHECK (expires_at_ms - updated_at_ms BETWEEN 1000 AND 86400000)
);
