CREATE TABLE IF NOT EXISTS live_blocks (
  blocker_id TEXT NOT NULL REFERENCES live_accounts(id) ON DELETE CASCADE,
  blocked_id TEXT NOT NULL REFERENCES live_accounts(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id)
);
CREATE INDEX IF NOT EXISTS live_blocks_blocked_idx ON live_blocks(blocked_id);
CREATE TABLE IF NOT EXISTS live_reports (
  id TEXT PRIMARY KEY,
  reporter_id TEXT NOT NULL REFERENCES live_accounts(id) ON DELETE CASCADE,
  target_id TEXT REFERENCES live_accounts(id) ON DELETE SET NULL,
  conversation_id TEXT,
  reason TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','reviewed','closed'))
);
CREATE INDEX IF NOT EXISTS live_reports_created_idx ON live_reports(created_at DESC);
