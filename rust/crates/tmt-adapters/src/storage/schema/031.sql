ALTER TABLE office_meeting_rooms ADD COLUMN retired INTEGER NOT NULL DEFAULT 0
    CHECK (retired IN (0, 1));
