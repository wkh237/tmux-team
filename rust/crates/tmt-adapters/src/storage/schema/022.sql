CREATE TABLE office_whiteboard_snapshots (
  snapshot_id TEXT PRIMARY KEY NOT NULL CHECK (length(snapshot_id) = 36),
  world_id TEXT NOT NULL REFERENCES office_local_worlds(id),
  intent_digest TEXT NOT NULL CHECK (length(intent_digest) = 64),
  document_id TEXT NOT NULL CHECK (document_id = 'lobby' OR length(document_id) = 36),
  document_revision INTEGER NOT NULL CHECK (typeof(document_revision) = 'integer' AND document_revision BETWEEN 1 AND 9007199254740991),
  scene TEXT NOT NULL CHECK (length(CAST(scene AS BLOB)) <= 2097152),
  selected_element_ids TEXT NOT NULL CHECK (length(CAST(selected_element_ids AS BLOB)) <= 81920),
  annotation TEXT NOT NULL CHECK (length(CAST(annotation AS BLOB)) <= 16384),
  created_at_ms INTEGER NOT NULL CHECK (typeof(created_at_ms) = 'integer' AND created_at_ms BETWEEN 1 AND 9007199254740991)
);

CREATE TABLE office_whiteboard_snapshot_images (
  snapshot_id TEXT PRIMARY KEY NOT NULL REFERENCES office_whiteboard_snapshots(snapshot_id),
  pixel_digest TEXT NOT NULL CHECK (length(pixel_digest) = 64),
  png BLOB NOT NULL CHECK (typeof(png) = 'blob' AND length(png) BETWEEN 1 AND 8388608)
);
