-- Historical scope survives membership changes; existing requests stay unscoped.
-- No foreign key: room lifecycle must not cascade into retained exchanges.
ALTER TABLE request_attempts ADD COLUMN room_id TEXT;

CREATE INDEX request_attempts_room_recipient_attention ON request_attempts (
  recipient_identity_id, room_id, status, recipient_attention_revision, request_id
) WHERE route_kind = 'inbox';
CREATE INDEX request_attempts_room_response_attention ON request_attempts (
  originator_identity_id, room_id, attention_revision, request_id
) WHERE response_submitted_at_ms IS NOT NULL;
