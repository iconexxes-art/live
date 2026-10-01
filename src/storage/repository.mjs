import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryRealtimeBroker } from '../realtime-broker.mjs';

const TABLES = ['accounts','requests','conversations','convMeta','sessions','blocks','reports','keyTransparency'];

class JsonRepository {
  constructor(dataDir) {
    this.dataDir = dataDir;
    mkdirSync(dataDir, { recursive: true });
    this.files = {
      accounts: join(dataDir, 'accounts.json'),
      requests: join(dataDir, 'requests.json'),
      conversations: join(dataDir, 'conversations.json'),
      convMeta: join(dataDir, 'conv-meta.json'),
      sessions: join(dataDir, 'sessions.json'),
      blocks: join(dataDir, 'blocks.json'),
      reports: join(dataDir, 'reports.json'),
      keyTransparency: join(dataDir, 'key-transparency.json'),
    };
  }
  read(file, fallback) { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; } }
  async load() {
    const out = {
      accounts: this.read(this.files.accounts, []),
      requests: this.read(this.files.requests, []),
      conversations: this.read(this.files.conversations, {}),
      convMeta: this.read(this.files.convMeta, {}),
      sessions: this.read(this.files.sessions, {}),
    };
    try { out.blocks = JSON.parse(readFileSync(this.files.blocks, 'utf8')); } catch {}
    try { out.reports = JSON.parse(readFileSync(this.files.reports, 'utf8')); } catch {}
    try { out.keyTransparency = JSON.parse(readFileSync(this.files.keyTransparency, 'utf8')); } catch {}
    return out;
  }
  async save(state) {
    for (const key of TABLES) {
      if (key === 'keyTransparency' && state[key] === undefined) continue;
      const file = this.files[key]; const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(state[key] ?? (key === 'conversations' || key === 'convMeta' || key === 'sessions' ? {} : []))); renameSync(tmp, file);
    }
  }
  createRealtimeBroker() { return new MemoryRealtimeBroker(); }
  async close() {}
}

const MIGRATION_1 = `
CREATE TABLE IF NOT EXISTS live_schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS live_state (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);`;

const MIGRATION_2 = `
CREATE TABLE IF NOT EXISTS live_accounts (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  initial TEXT NOT NULL,
  accent TEXT NOT NULL,
  bg TEXT NOT NULL,
  fg TEXT NOT NULL,
  ring TEXT NOT NULL,
  pass_hash TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS live_accounts_username_idx ON live_accounts(username);

CREATE TABLE IF NOT EXISTS live_requests (
  id TEXT PRIMARY KEY,
  from_account_id TEXT NOT NULL REFERENCES live_accounts(id) ON DELETE CASCADE,
  to_account_id TEXT NOT NULL REFERENCES live_accounts(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending','accepted','declined')),
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS live_requests_from_idx ON live_requests(from_account_id, status);
CREATE INDEX IF NOT EXISTS live_requests_to_idx ON live_requests(to_account_id, status);

CREATE TABLE IF NOT EXISTS live_conversations (
  id TEXT PRIMARY KEY,
  last_at BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS live_conversation_members (
  conversation_id TEXT NOT NULL REFERENCES live_conversations(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES live_accounts(id) ON DELETE CASCADE,
  PRIMARY KEY (conversation_id, account_id)
);
CREATE INDEX IF NOT EXISTS live_conversation_members_account_idx ON live_conversation_members(account_id);

CREATE TABLE IF NOT EXISTS live_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES live_conversations(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES live_accounts(id) ON DELETE RESTRICT,
  text TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  via TEXT NOT NULL DEFAULT 'draft',
  ephemeral BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at BIGINT
);
CREATE INDEX IF NOT EXISTS live_messages_conversation_idx ON live_messages(conversation_id, created_at, id);
CREATE INDEX IF NOT EXISTS live_messages_expiry_idx ON live_messages(expires_at) WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS live_sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES live_accounts(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS live_sessions_account_idx ON live_sessions(account_id);
CREATE INDEX IF NOT EXISTS live_sessions_expiry_idx ON live_sessions(expires_at);

CREATE TABLE IF NOT EXISTS live_conversation_meta (
  conversation_id TEXT PRIMARY KEY REFERENCES live_conversations(id) ON DELETE CASCADE,
  last_at BIGINT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS live_messages_author_idx ON live_messages(author_id);


`;

const MIGRATION_3 = `
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
`;

const MIGRATION_4 = `CREATE TABLE IF NOT EXISTS live_device_bundles (
  device_id TEXT PRIMARY KEY REFERENCES live_devices(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES live_accounts(id) ON DELETE CASCADE,
  signing_public_key JSONB NOT NULL, signed_prekey JSONB NOT NULL,
  signed_prekey_signature TEXT NOT NULL, prekeys JSONB NOT NULL DEFAULT '[]'::jsonb, updated_at BIGINT NOT NULL
); CREATE INDEX IF NOT EXISTS live_device_bundles_account_idx ON live_device_bundles(account_id);`;
const MIGRATION_5 = `CREATE TABLE IF NOT EXISTS live_devices (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES live_accounts(id) ON DELETE CASCADE,
  public_key JSONB NOT NULL, fingerprint TEXT NOT NULL, verified BOOLEAN NOT NULL DEFAULT FALSE,
  first_seen_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, verified_at BIGINT
); CREATE UNIQUE INDEX IF NOT EXISTS live_devices_account_fingerprint_idx ON live_devices(account_id, fingerprint);
CREATE INDEX IF NOT EXISTS live_devices_account_idx ON live_devices(account_id);`;
const MIGRATION_6 = `CREATE TABLE IF NOT EXISTS live_device_bundles (
  device_id TEXT PRIMARY KEY REFERENCES live_devices(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES live_accounts(id) ON DELETE CASCADE,
  signing_public_key JSONB NOT NULL, signed_prekey JSONB NOT NULL,
  signed_prekey_signature TEXT NOT NULL, prekeys JSONB NOT NULL DEFAULT '[]'::jsonb, updated_at BIGINT NOT NULL
); CREATE INDEX IF NOT EXISTS live_device_bundles_account_idx ON live_device_bundles(account_id);`;

const MIGRATION_7 = `CREATE TABLE IF NOT EXISTS live_key_transparency (
  id BIGSERIAL PRIMARY KEY, account_id TEXT NOT NULL REFERENCES live_accounts(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL, fingerprint TEXT NOT NULL, action TEXT NOT NULL CHECK (action IN ('registered','rotated','verified','unverified')),
  previous_hash TEXT NOT NULL, event_hash TEXT NOT NULL UNIQUE, created_at BIGINT NOT NULL
); CREATE INDEX IF NOT EXISTS live_key_transparency_account_idx ON live_key_transparency(account_id, id);`;


class PostgresRepository {
  constructor(pool) { this.pool = pool; this.normalized = true; }

  async migrate() {
    await this.pool.query(MIGRATION_1);
    await this.pool.query(MIGRATION_2);
    await this.pool.query(MIGRATION_3);
    await this.pool.query(MIGRATION_5);
    await this.pool.query(MIGRATION_6);
    await this.pool.query(MIGRATION_7);
    await this.pool.query(`INSERT INTO live_schema_migrations(version) VALUES (1), (2), (3), (4), (5), (6), (7) ON CONFLICT (version) DO NOTHING;`);
    await this.importLegacyStateIfNeeded();
  }

  async importLegacyStateIfNeeded() {
    const { rows } = await this.pool.query('SELECT COUNT(*)::int AS n FROM live_accounts');
    if (rows[0].n !== 0) return;
    const legacy = await this.pool.query("SELECT value FROM live_state WHERE key = 'accounts'");
    if (!legacy.rows.length || !Array.isArray(legacy.rows[0].value) || legacy.rows[0].value.length === 0) return;

    const state = { accounts: [], requests: [], conversations: {}, convMeta: {}, sessions: {}, blocks: [], reports: [] };
    const keys = await this.pool.query('SELECT key, value FROM live_state');
    for (const row of keys.rows) if (TABLES.includes(row.key)) state[row.key] = row.value;
    await this.save(state);
  }

  async save(state) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const a of state.accounts ?? []) {
        await client.query(`INSERT INTO live_accounts(id,username,name,initial,accent,bg,fg,ring,pass_hash,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO UPDATE SET username=EXCLUDED.username,name=EXCLUDED.name,initial=EXCLUDED.initial,accent=EXCLUDED.accent,bg=EXCLUDED.bg,fg=EXCLUDED.fg,ring=EXCLUDED.ring,pass_hash=EXCLUDED.pass_hash`, [a.id,a.username,a.name,a.initial,a.accent,a.bg,a.fg,a.ring,a.passHash,a.createdAt]);
      }
      const convIds = new Set(Object.keys(state.conversations ?? {}));
      for (const id of Object.keys(state.convMeta ?? {})) convIds.add(id);
      for (const id of convIds) {
        const lastAt = Number(state.convMeta?.[id]?.lastAt ?? 0);
        await client.query('INSERT INTO live_conversations(id,last_at) VALUES ($1,$2) ON CONFLICT(id) DO UPDATE SET last_at=GREATEST(live_conversations.last_at,EXCLUDED.last_at)', [id,lastAt]);
        const parts=id.split(':');
        if(parts[0]==='dm'&&parts.length===3) for(const accountId of [parts[1],parts[2]]) await client.query('INSERT INTO live_conversation_members(conversation_id,account_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[id,accountId]);
      }
      for (const b of state.blocks ?? []) await client.query('INSERT INTO live_blocks(blocker_id,blocked_id,created_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[b.blockerId,b.blockedId,b.createdAt]);
      for (const r of state.reports ?? []) await client.query('INSERT INTO live_reports(id,reporter_id,target_id,conversation_id,reason,details,created_at,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO UPDATE SET status=EXCLUDED.status,details=EXCLUDED.details',[r.id,r.reporterId,r.targetId??null,r.conversationId??null,r.reason,r.details??'',r.createdAt,r.status??'open']);
      for (const r of state.requests ?? []) {
        await client.query(`INSERT INTO live_requests(id,from_account_id,to_account_id,status,created_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET status=EXCLUDED.status`, [r.id,r.from,r.to,r.status,r.createdAt]);
      }
      for (const [conversationId,messages] of Object.entries(state.conversations ?? {})) {
        for (const m of (messages ?? [])) await client.query(`INSERT INTO live_messages(id,conversation_id,author_id,text,created_at,via,ephemeral,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO UPDATE SET text=EXCLUDED.text,expires_at=EXCLUDED.expires_at`, [m.id,conversationId,m.authorId,String(m.text??''),Number(m.createdAt??0),m.via??'draft',!!m.ephemeral,m.expiresAt??null]);
      }
      for (const [accountId, devices] of Object.entries(state.deviceKeys ?? {})) for (const d of (Array.isArray(devices) ? devices : [])) {
        await client.query(`INSERT INTO live_devices(id,account_id,public_key,fingerprint,verified,first_seen_at,updated_at,verified_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO UPDATE SET public_key=EXCLUDED.public_key,fingerprint=EXCLUDED.fingerprint,verified=EXCLUDED.verified,updated_at=EXCLUDED.updated_at,verified_at=EXCLUDED.verified_at`, [d.deviceId,accountId,d.publicKey,d.fingerprint,!!d.verified,d.firstSeenAt,d.updatedAt,d.verifiedAt??null]);
      }
      for (const [accountId, bundles] of Object.entries(state.deviceBundles ?? {})) for (const [deviceId, b] of Object.entries(bundles ?? {})) {
        await client.query(`INSERT INTO live_device_bundles(device_id,account_id,signing_public_key,signed_prekey,signed_prekey_signature,prekeys,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(device_id) DO UPDATE SET signing_public_key=EXCLUDED.signing_public_key,signed_prekey=EXCLUDED.signed_prekey,signed_prekey_signature=EXCLUDED.signed_prekey_signature,prekeys=EXCLUDED.prekeys,updated_at=EXCLUDED.updated_at`, [deviceId,accountId,b.signingPublicKey,b.signedPrekey,b.signedPrekeySignature,JSON.stringify(b.prekeys??[]),b.updatedAt]);
      }
      await client.query('DELETE FROM live_messages WHERE expires_at IS NOT NULL AND expires_at <= $1',[Date.now()]);
      await client.query('DELETE FROM live_sessions WHERE expires_at <= $1',[Date.now()]);
      await client.query('DELETE FROM live_key_transparency');
      for (const [accountId, entries] of Object.entries(state.keyTransparency ?? {})) for (const e of (entries ?? [])) {
        await client.query(`INSERT INTO live_key_transparency(id,account_id,device_id,fingerprint,action,previous_hash,event_hash,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [e.id,accountId,e.deviceId,e.fingerprint,e.action,e.previousHash,e.eventHash,e.createdAt]);
      }
      await client.query('COMMIT');
    } catch(e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  }
  async load() {
    const accountsQ = await this.pool.query('SELECT id,username,name,initial,accent,bg,fg,ring,pass_hash AS "passHash",created_at AS "createdAt" FROM live_accounts ORDER BY created_at,id');
    const requestsQ = await this.pool.query('SELECT id,from_account_id AS "from",to_account_id AS "to",status,created_at AS "createdAt" FROM live_requests ORDER BY created_at,id');
    const convQ = await this.pool.query('SELECT id,last_at FROM live_conversations ORDER BY id');
    const messagesQ = await this.pool.query('SELECT id,conversation_id AS "conversationId",author_id AS "authorId",text,created_at AS "createdAt",via,ephemeral,expires_at AS "expiresAt" FROM live_messages ORDER BY conversation_id,created_at,id');
    const blocksQ = await this.pool.query('SELECT blocker_id AS "blockerId",blocked_id AS "blockedId",created_at AS "createdAt" FROM live_blocks ORDER BY created_at');
    const reportsQ = await this.pool.query('SELECT id,reporter_id AS "reporterId",target_id AS "targetId",conversation_id AS "conversationId",reason,details,created_at AS "createdAt",status FROM live_reports ORDER BY created_at');
    const sessionsQ = await this.pool.query('SELECT token_hash,account_id AS "accountId",created_at AS "createdAt",expires_at AS "expiresAt" FROM live_sessions WHERE expires_at > $1', [Date.now()]);
    const convMeta = {};
    const conversations = {};
    for (const c of convQ.rows) { convMeta[c.id] = { lastAt: Number(c.last_at) }; conversations[c.id] = []; }
    for (const m of messagesQ.rows) { m.createdAt = Number(m.createdAt); m.expiresAt = m.expiresAt == null ? null : Number(m.expiresAt); (conversations[m.conversationId] ??= []).push(m); }
    // Session tokens are not recoverable from hashes. This is deliberate: server sessions are memory-bound.
    const devicesQ = await this.pool.query('SELECT id AS "deviceId",account_id AS "accountId",public_key AS "publicKey",fingerprint,verified,first_seen_at AS "firstSeenAt",updated_at AS "updatedAt",verified_at AS "verifiedAt" FROM live_devices');
    const deviceKeys = {};
    for (const d of devicesQ.rows) (deviceKeys[d.accountId] ??= []).push(d);
    const bundlesQ = await this.pool.query('SELECT device_id AS "deviceId",account_id AS "accountId",signing_public_key AS "signingPublicKey",signed_prekey AS "signedPrekey",signed_prekey_signature AS "signedPrekeySignature",prekeys,updated_at AS "updatedAt" FROM live_device_bundles');
    const deviceBundles = {};
    for (const b of bundlesQ.rows) (deviceBundles[b.accountId] ??= {})[b.deviceId] = b;
    const transparencyQ = await this.pool.query('SELECT id,account_id AS "accountId",device_id AS "deviceId",fingerprint,action,previous_hash AS "previousHash",event_hash AS "eventHash",created_at AS "createdAt" FROM live_key_transparency ORDER BY id');
    const keyTransparency = {};
    for (const e of transparencyQ.rows) (keyTransparency[e.accountId] ??= []).push(e);
    return { accounts: accountsQ.rows, requests: requestsQ.rows, conversations, convMeta, sessions: {}, blocks: blocksQ.rows, reports: reportsQ.rows, deviceKeys, deviceBundles, keyTransparency };
  }
  createRealtimeBroker() { return new (requireBrokerClass())(this.pool); }
  async close() { await this.pool.end(); }
}

let _BrokerClass;
function requireBrokerClass(){ if(!_BrokerClass) throw new Error('Broker class not initialized'); return _BrokerClass; }

async function hashToken(token) {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(token).digest('hex');
}

export async function createRepository({ dataDir }) {
  if (!process.env.DATABASE_URL) return new JsonRepository(dataDir);
  try {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: Number(process.env.PG_POOL_SIZE || 10) });
    const repo = new PostgresRepository(pool);
    await repo.migrate();
    const { PostgresRealtimeBroker } = await import('../realtime-broker.mjs');
    _BrokerClass = PostgresRealtimeBroker;
    return repo;
  } catch (error) {
    if (process.env.REQUIRE_DATABASE === '1') throw error;
    console.warn(`LIVE database unavailable; using JSON compatibility store: ${error.message}`);
    return new JsonRepository(dataDir);
  }
}
