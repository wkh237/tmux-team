CREATE TABLE identities_with_lifetime (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  lifetime TEXT NOT NULL DEFAULT 'saved'
    CHECK (lifetime IN ('temporary', 'saved')),
  retired_at_ms INTEGER
    CHECK (retired_at_ms IS NULL OR (
      typeof(retired_at_ms) = 'integer' AND
      retired_at_ms > 0 AND retired_at_ms <= 9007199254740991
    ))
);
INSERT INTO identities_with_lifetime (id, name, canonical_name, created_at, updated_at)
  SELECT id, name, canonical_name, created_at, updated_at FROM identities;
DROP TABLE identities;
ALTER TABLE identities_with_lifetime RENAME TO identities;
CREATE UNIQUE INDEX identities_active_name
  ON identities (canonical_name) WHERE retired_at_ms IS NULL;
