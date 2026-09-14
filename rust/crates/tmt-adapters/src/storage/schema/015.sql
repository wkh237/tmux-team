CREATE TABLE office_local_profiles (
  identity_id TEXT PRIMARY KEY REFERENCES identities(id),
  revision INTEGER NOT NULL CHECK (
    typeof(revision) = 'integer' AND
    revision BETWEEN 1 AND 9007199254740991
  ),
  profile TEXT NOT NULL CHECK (length(CAST(profile AS BLOB)) <= 4096),
  updated_at_ms INTEGER NOT NULL CHECK (
    typeof(updated_at_ms) = 'integer' AND
    updated_at_ms > 0 AND updated_at_ms <= 9007199254740991
  )
);
