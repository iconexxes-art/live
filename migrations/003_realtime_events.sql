-- LIVE v0.7 distributed realtime event plane.
CREATE SEQUENCE IF NOT EXISTS live_event_seq START 1;
CREATE TABLE IF NOT EXISTS live_events (
  seq BIGINT PRIMARY KEY DEFAULT nextval('live_event_seq'),
  conversation_id TEXT,
  envelope JSONB NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS live_events_conversation_seq_idx ON live_events(conversation_id, seq);
