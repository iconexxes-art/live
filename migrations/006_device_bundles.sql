CREATE TABLE IF NOT EXISTS live_device_bundles (
  device_id TEXT PRIMARY KEY REFERENCES live_devices(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES live_accounts(id) ON DELETE CASCADE,
  signing_public_key JSONB NOT NULL,
  signed_prekey JSONB NOT NULL,
  signed_prekey_signature TEXT NOT NULL,
  prekeys JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS live_device_bundles_account_idx ON live_device_bundles(account_id);
