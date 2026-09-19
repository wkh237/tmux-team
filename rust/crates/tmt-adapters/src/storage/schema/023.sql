CREATE TABLE office_dispatch_operations (
  operation_id TEXT PRIMARY KEY NOT NULL CHECK (length(operation_id) = 36),
  intent_digest TEXT NOT NULL CHECK (length(intent_digest) = 64),
  receipt TEXT NOT NULL CHECK (length(CAST(receipt AS BLOB)) BETWEEN 1 AND 16384)
);
