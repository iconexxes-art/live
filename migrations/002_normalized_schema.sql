-- LIVE v0.5 normalized PostgreSQL schema.
-- The executable migration is kept in src/storage/repository.mjs so the prototype remains self-contained.

CREATE TABLE IF NOT EXISTS live_accounts (...);
-- See src/storage/repository.mjs::MIGRATION_2 for the authoritative SQL used by the runtime.
