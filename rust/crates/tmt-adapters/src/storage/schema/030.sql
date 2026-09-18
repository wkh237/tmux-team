-- Keep one board store; room scopes classify content, not access permissions.
CREATE TABLE office_board_entries_scoped (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  thread_id TEXT NOT NULL CHECK (length(thread_id) = 36),
  is_root INTEGER NOT NULL CHECK (is_root IN (0, 1)),
  category_kind TEXT NOT NULL CHECK (category_kind IN ('general', 'repository', 'room')),
  category_id TEXT,
  author_kind TEXT NOT NULL CHECK (author_kind IN ('owner', 'identity')),
  author_id TEXT NOT NULL,
  author_name TEXT,
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  created_sequence INTEGER NOT NULL UNIQUE,
  activity_sequence INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  title TEXT,
  body TEXT,
  CHECK ((category_kind = 'general' AND category_id IS NULL) OR
         (category_kind = 'repository' AND category_id IS NOT NULL) OR
         (category_kind = 'room' AND category_id IS NOT NULL AND length(category_id) = 36)),
  CHECK ((is_root = 1 AND thread_id = id) OR is_root = 0),
  CHECK ((author_kind = 'owner' AND author_name IS NULL) OR (author_kind = 'identity' AND author_name IS NOT NULL))
);

INSERT INTO office_board_entries_scoped
  SELECT id, thread_id, is_root, category_kind, repository_id, author_kind,
         author_id, author_name, revision, deleted, created_sequence,
         activity_sequence, created_at_ms, updated_at_ms, title, body
  FROM office_board_entries;
DROP TABLE office_board_entries;
ALTER TABLE office_board_entries_scoped RENAME TO office_board_entries;

CREATE INDEX office_board_recent ON office_board_entries
  (category_kind, category_id, is_root, created_sequence DESC, id DESC);
CREATE INDEX office_board_updated ON office_board_entries
  (category_kind, category_id, is_root, activity_sequence DESC, id DESC);
CREATE INDEX office_board_replies ON office_board_entries
  (thread_id, is_root, created_sequence, id);
CREATE INDEX office_board_author ON office_board_entries
  (category_kind, category_id, is_root, author_kind, author_id, created_sequence DESC);
CREATE INDEX office_board_categories ON office_board_entries
  (is_root, category_kind, category_id);
