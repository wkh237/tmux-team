CREATE INDEX request_history_recipient ON request_attempts
  (recipient_identity_id, prepared_at_ms DESC, request_id DESC);
CREATE INDEX request_history_recipient_room ON request_attempts
  (recipient_identity_id, room_id, prepared_at_ms DESC, request_id DESC);
CREATE INDEX request_history_room ON request_attempts
  (room_id, prepared_at_ms DESC, request_id DESC);
