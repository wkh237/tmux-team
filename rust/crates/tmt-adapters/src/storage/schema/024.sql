CREATE TABLE office_meeting_rooms (
  room_id TEXT PRIMARY KEY CHECK(length(room_id) = 36),
  name TEXT NOT NULL CHECK(length(CAST(name AS BLOB)) BETWEEN 1 AND 80),
  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991)
);
CREATE TABLE office_meeting_members (
  room_id TEXT NOT NULL REFERENCES office_meeting_rooms(room_id) ON DELETE CASCADE,
  identity_id TEXT NOT NULL REFERENCES identities(id),
  PRIMARY KEY(room_id, identity_id)
);
