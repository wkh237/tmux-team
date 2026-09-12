CREATE TABLE identity_hooks (
    consumer TEXT NOT NULL CHECK (length(consumer) BETWEEN 1 AND 64),
    identity_id TEXT NOT NULL REFERENCES identities(id),
    reference TEXT NOT NULL CHECK (length(reference) BETWEEN 1 AND 256),
    state TEXT NOT NULL CHECK (state IN ('registered', 'pending', 'delivered')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (typeof(attempt_count) = 'integer' AND attempt_count >= 0),
    PRIMARY KEY (consumer, identity_id, reference)
);
CREATE INDEX identity_hooks_pending ON identity_hooks (consumer, state, attempt_count, identity_id, reference);
CREATE INDEX identity_hooks_retirement ON identity_hooks (identity_id, state);
