CREATE TABLE office_board_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 0 AND 9007199254740991),
  next_sequence INTEGER NOT NULL CHECK (next_sequence BETWEEN 1 AND 9007199254740991)
);
INSERT INTO office_board_state (singleton, revision, next_sequence) VALUES (1, 0, 1);

CREATE TABLE office_board_entries (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  thread_id TEXT NOT NULL CHECK (length(thread_id) = 36),
  is_root INTEGER NOT NULL CHECK (is_root IN (0, 1)),
  category_kind TEXT NOT NULL CHECK (category_kind IN ('general', 'repository')),
  repository_id TEXT,
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
  CHECK ((category_kind = 'general' AND repository_id IS NULL) OR (category_kind = 'repository' AND repository_id IS NOT NULL)),
  CHECK ((is_root = 1 AND thread_id = id) OR is_root = 0),
  CHECK ((author_kind = 'owner' AND author_name IS NULL) OR (author_kind = 'identity' AND author_name IS NOT NULL))
);

CREATE INDEX office_board_recent ON office_board_entries
  (category_kind, repository_id, is_root, created_sequence DESC, id DESC);
CREATE INDEX office_board_updated ON office_board_entries
  (category_kind, repository_id, is_root, activity_sequence DESC, id DESC);
CREATE INDEX office_board_replies ON office_board_entries
  (thread_id, is_root, created_sequence, id);
CREATE INDEX office_board_author ON office_board_entries
  (category_kind, repository_id, is_root, author_kind, author_id, created_sequence DESC);
CREATE INDEX office_board_categories ON office_board_entries
  (is_root, category_kind, repository_id);

CREATE TABLE office_board_operations (
  actor_key TEXT NOT NULL,
  operation_id TEXT NOT NULL CHECK (length(operation_id) = 36),
  intent_digest TEXT NOT NULL CHECK (length(intent_digest) = 64),
  result_kind TEXT NOT NULL CHECK (result_kind IN ('create', 'edit', 'delete')),
  entry_id TEXT NOT NULL CHECK (length(entry_id) = 36),
  thread_id TEXT,
  revision INTEGER NOT NULL,
  created INTEGER,
  changed INTEGER,
  deleted INTEGER,
  moderated INTEGER,
  PRIMARY KEY (actor_key, operation_id)
) WITHOUT ROWID;
