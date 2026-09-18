ALTER TABLE request_attempts ADD COLUMN request_kind TEXT NOT NULL DEFAULT 'request'
    CHECK (request_kind IN ('request', 'announcement'))
    CHECK (request_kind = 'request' OR (
        route_kind = 'inbox' AND wait_active = 0 AND preamble_every IS NULL
        AND response_submitted_at_ms IS NULL
    ));
