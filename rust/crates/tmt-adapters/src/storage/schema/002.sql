CREATE TABLE role_profiles (
  identity_id TEXT NOT NULL PRIMARY KEY REFERENCES identities(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
