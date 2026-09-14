CREATE TABLE office_prop_catalog (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  revision INTEGER NOT NULL CHECK (revision >= 0 AND revision <= 9007199254740991),
  previous_kind TEXT CHECK (previous_kind IN ('install', 'remove')),
  previous_digest TEXT,
  previous_base_revision INTEGER CHECK (previous_base_revision >= 0 AND previous_base_revision <= 9007199254740991),
  previous_result_revision INTEGER CHECK (previous_result_revision >= 1 AND previous_result_revision <= 9007199254740991),
  CHECK (
    (previous_kind IS NULL AND previous_digest IS NULL AND previous_base_revision IS NULL AND previous_result_revision IS NULL)
    OR
    (previous_kind IS NOT NULL AND previous_digest IS NOT NULL AND previous_base_revision IS NOT NULL AND previous_result_revision = previous_base_revision + 1)
  )
);

INSERT INTO office_prop_catalog (singleton, revision) VALUES (1, 0);

CREATE TABLE office_prop_packs (
  digest TEXT PRIMARY KEY COLLATE BINARY
    CHECK (length(digest) = 71 AND substr(digest, 1, 7) = 'sha256:'),
  bytes BLOB NOT NULL CHECK (length(bytes) <= 131072),
  prop_count INTEGER NOT NULL CHECK (prop_count BETWEEN 1 AND 16),
  installed_revision INTEGER NOT NULL UNIQUE
    CHECK (installed_revision >= 1 AND installed_revision <= 9007199254740991),
  installed_at_ms INTEGER NOT NULL CHECK (installed_at_ms >= 0)
);
