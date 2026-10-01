CREATE TABLE IF NOT EXISTS live_key_transparency (
  id BIGSERIAL PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES live_accounts(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('registered','rotated','verified','unverified')),
  previous_hash TEXT NOT NULL,
  event_hash TEXT NOT NULL UNIQUE,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS live_key_transparency_account_idx ON live_key_transparency(account_id, id);
