-- Retain exact v1 bytes and installation revisions while admitting bounded v2 art.
ALTER TABLE office_prop_packs RENAME TO office_prop_packs_previous;

CREATE TABLE office_prop_packs (
  digest TEXT PRIMARY KEY COLLATE BINARY
    CHECK (length(digest) = 71 AND substr(digest, 1, 7) = 'sha256:'),
  bytes BLOB NOT NULL CHECK (length(bytes) <= 524288),
  prop_count INTEGER NOT NULL CHECK (prop_count BETWEEN 1 AND 16),
  installed_revision INTEGER NOT NULL UNIQUE
    CHECK (installed_revision >= 1 AND installed_revision <= 9007199254740991),
  installed_at_ms INTEGER NOT NULL CHECK (installed_at_ms >= 0)
);

INSERT INTO office_prop_packs SELECT * FROM office_prop_packs_previous;
DROP TABLE office_prop_packs_previous;
