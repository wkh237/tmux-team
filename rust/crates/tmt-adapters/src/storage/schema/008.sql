ALTER TABLE request_attempts
  ADD COLUMN attention_revision INTEGER NOT NULL DEFAULT 0
    CHECK (
      typeof(attention_revision) = 'integer' AND
      attention_revision >= 0 AND attention_revision <= 9007199254740991
    );
ALTER TABLE request_attempts
  ADD COLUMN attention_acknowledged_revision INTEGER NOT NULL DEFAULT 0
    CHECK (
      typeof(attention_acknowledged_revision) = 'integer' AND
      attention_acknowledged_revision >= 0 AND attention_acknowledged_revision <= 9007199254740991
    );
CREATE TABLE request_attention_identities (
  identity_id TEXT PRIMARY KEY,
  latest_revision INTEGER NOT NULL CHECK (
    typeof(latest_revision) = 'integer' AND
    latest_revision >= 0 AND latest_revision <= 9007199254740991
  ),
  acknowledged_through INTEGER NOT NULL CHECK (
    typeof(acknowledged_through) = 'integer' AND
    acknowledged_through <= latest_revision AND
    acknowledged_through >= 0 AND acknowledged_through <= 9007199254740991
  )
);
WITH ranked AS (
  SELECT attempt_id,
         ROW_NUMBER() OVER (
           PARTITION BY originator_identity_id
           ORDER BY prepared_at_ms, request_id
         ) AS revision
  FROM request_attempts
  WHERE originator_identity_id IS NOT NULL
)
UPDATE request_attempts
SET attention_revision = (
  SELECT revision FROM ranked WHERE ranked.attempt_id = request_attempts.attempt_id
)
WHERE attempt_id IN (SELECT attempt_id FROM ranked);
INSERT INTO request_attention_identities (identity_id, latest_revision, acknowledged_through)
  SELECT originator_identity_id, MAX(attention_revision), 0
  FROM request_attempts
  WHERE originator_identity_id IS NOT NULL
  GROUP BY originator_identity_id;
CREATE INDEX request_attempts_attention
  ON request_attempts (originator_identity_id, attention_revision, request_id);
