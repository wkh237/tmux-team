-- One revision owns topology, personal assignments and ordered placements.
ALTER TABLE office_local_worlds ADD COLUMN layout_revision INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(layout_revision) = 'integer' AND layout_revision BETWEEN 0 AND 9007199254740991);
ALTER TABLE office_local_worlds ADD COLUMN layout_json TEXT
  CHECK (layout_json IS NULL OR length(CAST(layout_json AS BLOB)) <= 4194304);
ALTER TABLE office_local_worlds ADD COLUMN layout_updated_at_ms INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(layout_updated_at_ms) = 'integer' AND layout_updated_at_ms BETWEEN 0 AND 9007199254740991);

-- Old binaries must not resurrect a second writable layout after world cutover.
CREATE TRIGGER office_blocks_after_world_insert BEFORE INSERT ON office_local_blocks
WHEN EXISTS (SELECT 1 FROM office_local_worlds WHERE layout_revision > 0)
BEGIN SELECT RAISE(ABORT, 'Office layout uses the world editor'); END;
CREATE TRIGGER office_blocks_after_world_update BEFORE UPDATE ON office_local_blocks
WHEN EXISTS (SELECT 1 FROM office_local_worlds WHERE layout_revision > 0)
BEGIN SELECT RAISE(ABORT, 'Office layout uses the world editor'); END;
