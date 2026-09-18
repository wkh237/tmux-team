CREATE TABLE office_whiteboards (
  document_id TEXT PRIMARY KEY CHECK (document_id = 'lobby' OR length(document_id) = 36),
  world_id TEXT NOT NULL REFERENCES office_local_worlds(id),
  revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision BETWEEN 1 AND 9007199254740991),
  scene TEXT NOT NULL CHECK (length(CAST(scene AS BLOB)) <= 2097152),
  updated_at_ms INTEGER NOT NULL CHECK (typeof(updated_at_ms) = 'integer' AND updated_at_ms BETWEEN 1 AND 9007199254740991)
);

CREATE TABLE office_whiteboard_operations (
  world_id TEXT NOT NULL REFERENCES office_local_worlds(id),
  operation_id TEXT NOT NULL CHECK (length(operation_id) = 36),
  intent_digest TEXT NOT NULL CHECK (length(intent_digest) = 64),
  document_id TEXT NOT NULL REFERENCES office_whiteboards(document_id),
  revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision BETWEEN 1 AND 9007199254740991),
  changed INTEGER NOT NULL CHECK (changed IN (0, 1)),
  updated_at_ms INTEGER NOT NULL CHECK (typeof(updated_at_ms) = 'integer' AND updated_at_ms BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY (world_id, operation_id)
) WITHOUT ROWID;
