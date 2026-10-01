CREATE TABLE IF NOT EXISTS live_devices (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES live_accounts(id) ON DELETE CASCADE,
  public_key JSONB NOT NULL,
  fingerprint TEXT NOT NULL,
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  first_seen_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  verified_at BIGINT
);
CREATE UNIQUE INDEX IF NOT EXISTS live_devices_account_fingerprint_idx ON live_devices(account_id, fingerprint);
CREATE INDEX IF NOT EXISTS live_devices_account_idx ON live_devices(account_id);
