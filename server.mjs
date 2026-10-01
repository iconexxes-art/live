/* LIVE secure prototype server.
   The server is the trust boundary: clients are untrusted, conversation
   routing is authorization-scoped, sessions are HttpOnly cookies, and
   committed message metadata is server-authoritative. */

import { createServer } from 'node:http';
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual, generateKeyPairSync, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { createRepository } from './src/storage/repository.mjs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const DATA = join(ROOT, 'data');
const ACCOUNTS_FILE = join(DATA, 'accounts.json');
const CONVOS_FILE = join(DATA, 'conversations.json');
const SESSIONS_FILE = join(DATA, 'sessions.json');
const CONVMETA_FILE = join(DATA, 'conv-meta.json');
const REQUESTS_FILE = join(DATA, 'requests.json');
const BLOCKS_FILE = join(DATA, 'blocks.json');
const REPORTS_FILE = join(DATA, 'reports.json');
const KEYS_FILE = join(DATA, 'device-keys.json');
const TRANSPARENCY_FILE = join(DATA, 'key-transparency.json');
const TRANSPARENCY_KEY_FILE = join(DATA, 'transparency-server-key.json');
const PORT = Number(process.env.PORT || 5173);
const MAX_BODY = 100 * 1024;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MESSAGE_TTL_MS = 8000;
const DRAFT_TTL_MS = 10 * 60 * 1000;
const PASSWORD_MIN = 10;
const COOKIE = 'live_session';
const SCRYPT_PREFIX = 'scrypt$v1$';

const ACCENTS = {
  cyan: { bg: '#10333c', fg: '#8fe3ff', ring: 'rgba(89,210,255,0.35)' },
  violet: { bg: '#282142', fg: '#cfc2ff', ring: 'rgba(160,140,255,0.35)' },
  amber: { bg: '#3a2c14', fg: '#f2ce8a', ring: 'rgba(227,192,120,0.35)' },
  rose: { bg: '#3a1620', fg: '#f2a0b8', ring: 'rgba(242,160,184,0.35)' },
  slate: { bg: '#1c2027', fg: '#c3cad4', ring: 'rgba(255,255,255,0.22)' },
};
const ACCENT_KEYS = Object.keys(ACCENTS);
const E2EE_ENABLED = process.env.LIVE_E2EE === '1';
const MAX_DEVICES_PER_ACCOUNT = Number(process.env.MAX_DEVICES_PER_ACCOUNT || 5);
const CLIENT_EVENTS = new Set([
  'draft.started', 'draft.updated', 'draft.paused', 'draft.sent',
  'draft.discarded', 'draft.deleted', 'draft.resync',
  'user.joined', 'user.left', 'presence.ping', 'e2ee.session.init',
]);
const CONVERSATION_EVENTS = new Set([
  'draft.started', 'draft.updated', 'draft.paused', 'draft.sent',
  'draft.discarded', 'draft.deleted', 'draft.resync',
  'e2ee.session.init',
  'user.joined', 'user.left', 'presence.ping',
]);

mkdirSync(DATA, { recursive: true });
const loadJSON = (file, fallback) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; } };
const persistJSON = (file, obj) => { const tmp = `${file}.tmp`; writeFileSync(tmp, JSON.stringify(obj)); renameSync(tmp, file); };

const bootstrap = {
  accounts: loadJSON(ACCOUNTS_FILE, []),
  conversations: loadJSON(CONVOS_FILE, {}),
  convMeta: loadJSON(CONVMETA_FILE, {}),
  requests: loadJSON(REQUESTS_FILE, []),
  sessions: loadJSON(SESSIONS_FILE, {}),
  blocks: loadJSON(BLOCKS_FILE, []),
  reports: loadJSON(REPORTS_FILE, []),
  deviceKeys: loadJSON(KEYS_FILE, {}),
  deviceBundles: loadJSON(join(DATA, 'device-bundles.json'), {}),
  keyTransparency: loadJSON(TRANSPARENCY_FILE, {}),
};
const repository = await createRepository({ dataDir: DATA });
const realtimeBroker = repository.createRealtimeBroker();
if (realtimeBroker.ready) await realtimeBroker.ready;
const persisted = await repository.load();
const accounts = persisted.accounts?.length ? persisted.accounts : bootstrap.accounts;
const conversations = Object.keys(persisted.conversations ?? {}).length ? persisted.conversations : bootstrap.conversations;
const convMeta = Object.keys(persisted.convMeta ?? {}).length ? persisted.convMeta : bootstrap.convMeta;
const requests = persisted.requests?.length ? persisted.requests : bootstrap.requests;
const blocks = persisted.blocks?.length ? persisted.blocks : bootstrap.blocks;
const reports = persisted.reports?.length ? persisted.reports : bootstrap.reports;
const deviceKeys = persisted.deviceKeys ?? bootstrap.deviceKeys;
const deviceBundles = persisted.deviceBundles ?? bootstrap.deviceBundles;
const keyTransparency = persisted.keyTransparency ?? bootstrap.keyTransparency;
/* Existing demo sessions are intentionally invalidated. Old tokens were stored
   in the project archive and must never remain valid after the hardening pass. */
const sessionTokens = persisted.sessions ?? {};
const databaseWasEmpty = !persisted.accounts?.length && !Object.keys(persisted.conversations ?? {}).length && !persisted.requests?.length;
if (process.env.DATABASE_URL && databaseWasEmpty && (bootstrap.accounts.length || Object.keys(bootstrap.conversations).length || bootstrap.requests.length)) {
  await repository.save({ accounts, requests, conversations, convMeta, sessions: {}, blocks, reports });
}
// Existing demo sessions are intentionally invalidated on startup.
for (const token of Object.keys(sessionTokens)) delete sessionTokens[token];

const transparencyKeyState = (() => {
  const envPrivate = process.env.LIVE_TRANSPARENCY_PRIVATE_KEY;
  if (envPrivate) {
    const privateKey = createPrivateKey(envPrivate.replace(/\\n/g, '\n'));
    return { privateKey, publicKey: createPublicKey(privateKey).export({ format:'jwk' }) };
  }
  const saved = loadJSON(TRANSPARENCY_KEY_FILE, null);
  if (saved?.privateKeyPem) {
    const privateKey = createPrivateKey(saved.privateKeyPem);
    return { privateKey, publicKey: saved.publicKey ?? createPublicKey(privateKey).export({format:'jwk'}) };
  }
  const pair = generateKeyPairSync('ec', { namedCurve:'prime256v1' });
  const privateKeyPem = pair.privateKey.export({format:'pem',type:'pkcs8'});
  const publicKey = pair.publicKey.export({format:'jwk'});
  persistJSON(TRANSPARENCY_KEY_FILE, { privateKeyPem, publicKey });
  return { privateKey: pair.privateKey, publicKey };
})();
const canonical = (value) => JSON.stringify(value);
const transparencyEventHash = (entry) => createHash('sha256').update(canonical({accountId:entry.accountId,deviceId:entry.deviceId,fingerprint:entry.fingerprint,action:entry.action,previousHash:entry.previousHash,createdAt:entry.createdAt})).digest('hex');
function appendTransparency(accountId, deviceId, fingerprint, action) {
  const list = keyTransparency[accountId] ?? (keyTransparency[accountId] = []);
  const previousHash = list.at(-1)?.eventHash ?? '0'.repeat(64);
  const entry = { id: (list.at(-1)?.id ?? 0) + 1, accountId, deviceId, fingerprint, action, previousHash, createdAt: Date.now() };
  entry.eventHash = transparencyEventHash(entry);
  list.push(entry);
  return entry;
}
function transparencySnapshot(accountId) {
  const entries = keyTransparency[accountId] ?? [];
  const rootHash = entries.at(-1)?.eventHash ?? '0'.repeat(64);
  const signature = sign('sha256', Buffer.from(rootHash), { key: transparencyKeyState.privateKey, dsaEncoding:'ieee-p1363' }).toString('base64');
  return { version:1, accountId, entries, rootHash, signature, signingPublicKey:transparencyKeyState.publicKey };
}

const clients = new Map();
const MAX_CONNECTIONS_PER_ACCOUNT = Number(process.env.MAX_CONNECTIONS_PER_ACCOUNT || 5);
const MAX_CONNECTIONS_GLOBAL = Number(process.env.MAX_CONNECTIONS_GLOBAL || 5000);
const MAX_EVENT_PER_MINUTE = Number(process.env.MAX_EVENT_PER_MINUTE || 240);
const MAX_DRAFTS_PER_ACCOUNT = Number(process.env.MAX_DRAFTS_PER_ACCOUNT || 8);
const eventDedup = new Map(); // clientId -> { res|socket, accountId, transport }
const replayBuffer = [];
const MAX_REPLAY = 5000;
let globalSeq = await realtimeBroker.currentSeq();
const rateBuckets = new Map();
const activeDrafts = new Map(); // conversationId:draftId -> { authorId, visibility, rev, expiresAt }
const usernameIndex = new Map(accounts.map((a) => [a.username, a]));

let saveQueue = Promise.resolve();
const saveState = () => {
  const snapshot = { accounts, requests, conversations, convMeta, sessions: sessionTokens, blocks, reports, deviceKeys, deviceBundles, keyTransparency };
  saveQueue = saveQueue.then(() => repository.save(snapshot)).catch((error) => console.error('LIVE persistence error:', error));
  return saveQueue;
};
const saveAccounts = () => saveState();
const requestId = (req) => { const incoming = String(req.headers['x-request-id'] ?? ''); return /^[A-Za-z0-9._:-]{8,100}$/.test(incoming) ? incoming : randomUUID(); };
const saveConvos = () => saveState();
const saveSessions = () => saveState();
const saveConvMeta = () => saveState();
const saveRequests = () => saveState();

function legacySha256(s) { return createHash('sha256').update(s).digest('hex'); }
function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 }).toString('hex');
  return `${SCRYPT_PREFIX}${salt}$${derived}`;
}
function verifyPassword(password, account) {
  const stored = account?.passHash;
  if (!stored) return false;
  if (stored.startsWith(SCRYPT_PREFIX)) {
    const [, , salt, expectedHex] = stored.split('$');
    try {
      const expected = Buffer.from(expectedHex, 'hex');
      const actual = scryptSync(password, salt, expected.length, { N: 16384, r: 8, p: 1 });
      return expected.length === actual.length && timingSafeEqual(expected, actual);
    } catch { return false; }
  }
  const actual = legacySha256(`${account.salt ?? ''}:${password}`);
  return actual === stored;
}
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function cookieOptions(token) {
  const secure = process.env.NODE_ENV === 'production';
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure ? '; Secure' : ''}`;
}
function clearCookie() { return `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`; }
function sessionFor(req) {
  const token = parseCookies(req)[COOKIE];
  if (!token) return null;
  const session = sessionTokens[token];
  if (!session) return null;
  if (typeof session === 'string') { sessionTokens[token] = { accountId: session, createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_MS }; saveSessions(); }
  if (sessionTokens[token].expiresAt <= Date.now()) { delete sessionTokens[token]; saveSessions(); return null; }
  return { token, ...sessionTokens[token] };
}
function accountFor(req) {
  const s = sessionFor(req);
  return s ? accounts.find((a) => a.id === s.accountId) ?? null : null;
}
function publicAccount(a) {
  return a && { id: a.id, username: a.username, name: a.name, initial: a.initial, accent: a.accent, bg: a.bg, fg: a.fg, ring: a.ring, createdAt: a.createdAt };
}
function isBlocked(a,b) { return blocks.some(x => (x.blockerId===a && x.blockedId===b) || (x.blockerId===b && x.blockedId===a)); }
function connected(a, b) {
  if (isBlocked(a,b)) return false;
  return !!a && !!b && requests.some((r) => r.status === 'accepted' && ((r.from === a && r.to === b) || (r.from === b && r.to === a)));
}
function conversationParticipants(conversationId) {
  const parts = String(conversationId).split(':').filter(Boolean);
  if (parts.length !== 3 || parts[0] !== 'dm' || parts[1] === parts[2]) return null;
  const [a, b] = [parts[1], parts[2]];
  return connected(a, b) ? [a, b] : null;
}
function canAccessConversation(accountId, conversationId) {
  const p = conversationParticipants(conversationId);
  return !!p?.includes(accountId);
}
function targetsForConversation(conversationId) {
  const ids = conversationParticipants(conversationId) ?? [];
  return new Set([...clients.entries()].filter(([, c]) => ids.includes(c.accountId)).map(([id]) => id));
}
function targetsForAccounts(accountIds) {
  const set = new Set(accountIds);
  return new Set([...clients.entries()].filter(([, c]) => set.has(c.accountId)).map(([id]) => id));
}
function pushReplay(envelope, conversationId) {
  replayBuffer.push({ seq: envelope.seq, conversationId, envelope });
  if (replayBuffer.length > MAX_REPLAY) replayBuffer.splice(0, replayBuffer.length - MAX_REPLAY);
}
function sendClient(client, envelope) {
  try {
    if (client.transport === 'ws') client.socket.write(wsFrame(JSON.stringify(envelope)));
    else client.res.write(`data: ${JSON.stringify(envelope)}\n\n`);
  } catch {}
}
function audienceMatches(client, envelope) {
  if (envelope.conversationId) return canAccessConversation(client.accountId, envelope.conversationId);
  return Array.isArray(envelope.accountIds) && envelope.accountIds.includes(client.accountId);
}
function deliverEnvelope(envelope) {
  globalSeq = Math.max(globalSeq, Number(envelope.seq) || 0);
  if (envelope.conversationId) pushReplay(envelope, envelope.conversationId);
  for (const [id, client] of clients.entries()) {
    if (id === envelope.originClientId) continue;
    if (audienceMatches(client, envelope)) sendClient(client, envelope);
  }
}
realtimeBroker.onEvent((envelope) => deliverEnvelope(envelope));
async function emitToClients(event, clientIds, fromClientId = null, audienceAccountIds = null) {
  const accountIds = [...new Set(audienceAccountIds ?? [...clientIds].map(id => clients.get(id)?.accountId).filter(Boolean))];
  const envelope = { ...event, eid: randomUUID(), originClientId: fromClientId ?? null, accountIds, ts: Date.now() };
  const stored = await realtimeBroker.publish(event.conversationId ?? null, envelope);
  // The broker notification is authoritative. For implementations where notifications
  // are asynchronous, deliver immediately only if this process has not observed it yet.
  if (!stored.seq) return;
  globalSeq = Math.max(globalSeq, Number(stored.seq) || 0);
}
async function replayForClient(clientId, lastSeq = 0) {
  const client = clients.get(clientId); if (!client) return;
  const allowed = new Set();
  for (const r of requests) if (r.status === 'accepted' && (r.from === client.accountId || r.to === client.accountId)) {
    allowed.add(`dm:${r.from}:${r.to}`); allowed.add(`dm:${r.to}:${r.from}`);
  }
  const events = await realtimeBroker.replay(Math.max(0, Number(lastSeq) || 0), client.accountId, allowed);
  for (const envelope of events) if (audienceMatches(client, envelope)) sendClient(client, envelope);
}

async function emitConversation(event, fromClientId = null) {
  return emitToClients(event, targetsForConversation(event.conversationId), fromClientId, conversationParticipants(event.conversationId) ?? []);
}
async function emitAccounts(event, accountIds, fromClientId = null) {
  return emitToClients(event, targetsForAccounts(accountIds), fromClientId, accountIds);
}

/* Grandfather old conversations into accepted requests once, preserving the prototype data. */
for (const convId of Object.keys({ ...conversations, ...convMeta })) {
  const parts = convId.split(':').filter(Boolean);
  const a = parts[0] === 'dm' ? parts[1] : null;
  const b = parts[0] === 'dm' ? parts[2] : null;
  if (a && b && a !== b && accounts.some(x => x.id === a) && accounts.some(x => x.id === b) && !connected(a, b)) {
    requests.push({ id: randomUUID(), from: a, to: b, status: 'accepted', createdAt: Date.now() });
  }
}
if (requests.length) saveRequests();
saveSessions();

function cleanupOps() {
  const now=Date.now();
  for (const [k,v] of rateBuckets) if (now-v.start > 5*60_000) rateBuckets.delete(k);
  for (const [k,v] of eventDedup) if (now-v < 10*60_000) eventDedup.delete(k);
}
setInterval(cleanupOps, 60_000).unref();
function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  const b = rateBuckets.get(key) ?? { start: now, count: 0 };
  if (now - b.start >= windowMs) { b.start = now; b.count = 0; }
  b.count += 1;
  rateBuckets.set(key, b);
  return b.count <= limit;
}
function requestIp(req) { return String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? 'unknown').split(',')[0].trim(); }
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === String(req.headers.host); } catch { return false; }
}
function requireMutationOrigin(req, res) {
  if (!originAllowed(req)) { sendJSON(res, 403, { error: 'Cross-origin request blocked.' }); return false; }
  return true;
}

function securityHeaders(reqId) { return {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'X-Request-Id': reqId,
}; }
function sendJSON(res, status, obj, extraHeaders = {}) {
  const reqId = extraHeaders['X-Request-Id'] ?? randomUUID();
  res.writeHead(status, { ...securityHeaders(reqId), 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders });
  res.end(status === 204 ? '' : JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new Error('Invalid JSON.')); } });
    req.on('error', reject);
  });
}
function safeText(value, max = 4000) { return String(value ?? '').slice(0, max); }
function normalizeClientId(value) { const s = String(value ?? ''); return /^[A-Za-z0-9_-]{8,100}$/.test(s) ? s : randomUUID(); }

async function handleApi(req, res, url) {
  const path = url.pathname;
  const reqId = requestId(req);
  res.setHeader('X-Request-Id', reqId);
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && !requireMutationOrigin(req, res)) return;
  if (req.method === 'GET' && path === '/healthz') return sendJSON(res, 200, { ok:true, version:'0.11.0' });
  if (req.method === 'GET' && path === '/readyz') { try { await repository.load(); return sendJSON(res, 200, { ok:true, realtimeSeq:globalSeq }); } catch { return sendJSON(res, 503, { ok:false }); } }

  if (req.method === 'POST' && path === '/api/signup') {
    if (!rateLimit(`signup:${requestIp(req)}`, 5, 60_000)) return sendJSON(res, 429, { error: 'Too many signup attempts. Try again later.' });
    const body = await readBody(req);
    const uname = String(body.username ?? '').trim().toLowerCase();
    const display = String(body.name ?? '').trim().slice(0, 24) || uname;
    const password = String(body.password ?? '');
    if (!/^[a-z0-9_]{3,20}$/.test(uname)) return sendJSON(res, 400, { error: 'Username: 3–20 characters, letters a–z, numbers, underscore.' });
    if (accounts.some((a) => a.username === uname)) return sendJSON(res, 409, { error: 'That username is already taken.' });
    if (password.length < PASSWORD_MIN) return sendJSON(res, 400, { error: `Password needs at least ${PASSWORD_MIN} characters.` });
    const accent = ACCENT_KEYS[accounts.length % ACCENT_KEYS.length];
    const account = { id: 'u-' + randomBytes(8).toString('hex'), username: uname, name: display, initial: display[0].toUpperCase(), accent, ...ACCENTS[accent], passHash: hashPassword(password), createdAt: Date.now() };
    accounts.push(account); usernameIndex.set(account.username, account); saveAccounts();
    const token = randomBytes(32).toString('hex');
    sessionTokens[token] = { accountId: account.id, createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_MS }; saveSessions();
    return sendJSON(res, 200, { account: publicAccount(account) }, { 'Set-Cookie': cookieOptions(token) });
  }

  if (req.method === 'POST' && path === '/api/login') {
    if (!rateLimit(`login:${requestIp(req)}`, 8, 60_000)) return sendJSON(res, 429, { error: 'Too many login attempts. Try again later.' });
    const body = await readBody(req);
    const uname = String(body.username ?? '').trim().toLowerCase();
    const account = usernameIndex.get(uname);
    if (!account || !verifyPassword(String(body.password ?? ''), account)) return sendJSON(res, 401, { error: 'Invalid username or password.' });
    if (!String(account.passHash).startsWith(SCRYPT_PREFIX)) { account.passHash = hashPassword(String(body.password ?? '')); delete account.salt; saveAccounts(); }
    const token = randomBytes(32).toString('hex');
    sessionTokens[token] = { accountId: account.id, createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_MS }; saveSessions();
    return sendJSON(res, 200, { account: publicAccount(account) }, { 'Set-Cookie': cookieOptions(token) });
  }

  if (req.method === 'POST' && path === '/api/logout') {
    const s = sessionFor(req); if (s) { delete sessionTokens[s.token]; saveSessions(); }
    return sendJSON(res, 200, { ok: true }, { 'Set-Cookie': clearCookie() });
  }

  if (req.method === 'POST' && path === '/api/keys') {
    const account = accountFor(req); if (!account) return sendJSON(res, 401, { error: 'Invalid session.' });
    const body = await readBody(req); const key = body.publicKey;
    if (!key || key.kty !== 'EC' || key.crv !== 'P-256' || typeof key.x !== 'string' || typeof key.y !== 'string') return sendJSON(res, 400, { error: 'Invalid public key.' });
    const deviceId = /^[0-9a-f-]{20,80}$/i.test(String(body.deviceId||'')) ? String(body.deviceId) : null;
    if (!deviceId) return sendJSON(res, 400, { error:'Device ID required.' });
    const existing = Array.isArray(deviceKeys[account.id]) ? deviceKeys[account.id] : (deviceKeys[account.id] ? [{...deviceKeys[account.id],deviceId:'legacy'}] : []);
    const now=Date.now(); const fingerprint=createHash('sha256').update(JSON.stringify({kty:key.kty,crv:key.crv,x:key.x,y:key.y})).digest('hex').slice(0,32);
    const idx=existing.findIndex(d=>d.deviceId===deviceId);
    const previousFingerprint=idx>=0?existing[idx].fingerprint:null;
    const record={deviceId,publicKey:{kty:'EC',crv:'P-256',x:key.x,y:key.y},fingerprint,updatedAt:now,verified:idx>=0?Boolean(existing[idx].verified):false,firstSeenAt:idx>=0?existing[idx].firstSeenAt:now};
    if(existing.length>=MAX_DEVICES_PER_ACCOUNT && idx<0) return sendJSON(res,409,{error:'Device limit reached.'});
    if(idx>=0) {
      existing[idx]=record;
      if(previousFingerprint!==fingerprint) appendTransparency(account.id, deviceId, fingerprint, 'rotated');
    } else {
      existing.push(record);
      appendTransparency(account.id, deviceId, fingerprint, 'registered');
    }
    deviceKeys[account.id]=existing; saveState();
    return sendJSON(res, 200, { ok:true, deviceId, fingerprint, verified:record.verified, keyChanged:idx>=0 && previousFingerprint!==fingerprint });
  }
  if (req.method === 'GET' && path === '/api/keys') {
    const account = accountFor(req); if (!account) return sendJSON(res, 401, { error: 'Invalid session.' });
    const username = String(url.searchParams.get('username') || '').trim().toLowerCase();
    const target = usernameIndex.get(username);
    if (!target || target.id === account.id || !connected(account.id,target.id)) return sendJSON(res, 404, { error: 'Key unavailable.' });
    const records = Array.isArray(deviceKeys[target.id]) ? deviceKeys[target.id] : (deviceKeys[target.id] ? [deviceKeys[target.id]] : []);
    return records.length ? sendJSON(res, 200, { username:target.username, devices:records.map(({deviceId,publicKey,fingerprint,updatedAt,verified})=>({deviceId,publicKey,fingerprint,updatedAt,verified})), e2ee:E2EE_ENABLED }) : sendJSON(res, 404, { error:'No device key registered.' });
  }
  if (req.method === 'POST' && path === '/api/keys/verify') {
    const account=accountFor(req); if(!account) return sendJSON(res,401,{error:'Invalid session.'}); const body=await readBody(req);
    const target=usernameIndex.get(String(body.username||'').trim().toLowerCase()); if(!target || !connected(account.id,target.id)) return sendJSON(res,404,{error:'Key unavailable.'});
    const records=Array.isArray(deviceKeys[target.id])?deviceKeys[target.id]:[]; const rec=records.find(d=>d.deviceId===body.deviceId); if(!rec) return sendJSON(res,404,{error:'Device unavailable.'});
    if(body.verified!==true && body.verified!==false) return sendJSON(res,400,{error:'verified must be boolean.'}); rec.verified=body.verified; rec.verifiedAt=body.verified?Date.now():null; saveState();
    return sendJSON(res,200,{ok:true,deviceId:rec.deviceId,fingerprint:rec.fingerprint,verified:rec.verified});
  }

  if (req.method === 'GET' && path === '/api/keys/transparency') {
    const account=accountFor(req); if(!account) return sendJSON(res,401,{error:'Invalid session.'});
    const username=String(url.searchParams.get('username')||'').trim().toLowerCase(); const target=usernameIndex.get(username);
    if(!target || target.id===account.id || !connected(account.id,target.id)) return sendJSON(res,404,{error:'Transparency unavailable.'});
    return sendJSON(res,200,{username:target.username,e2ee:E2EE_ENABLED,...transparencySnapshot(target.id)});
  }

  if (req.method === 'POST' && path === '/api/keys/bundle') {
    const account=accountFor(req); if(!account) return sendJSON(res,401,{error:'Invalid session.'});
    const body=await readBody(req); const deviceId=String(body.deviceId||'');
    const base=Array.isArray(deviceKeys[account.id])?deviceKeys[account.id]:[]; const device=base.find(d=>d.deviceId===deviceId);
    if(!device) return sendJSON(res,404,{error:'Register the device identity first.'});
    const sp=body.signedPrekey, signing=body.signingPublicKey;
    if(!signing||signing.kty!=='EC'||signing.crv!=='P-256'||!sp||sp.kty!=='EC'||sp.crv!=='P-256'||typeof body.signedPrekeySignature!=='string') return sendJSON(res,400,{error:'Invalid device bundle.'});
    const prekeys=Array.isArray(body.prekeys)?body.prekeys.slice(0,50):[];
    if(prekeys.some(k=>!k||k.kty!=='EC'||k.crv!=='P-256'||typeof k.x!=='string'||typeof k.y!=='string'||typeof k.id!=='string')) return sendJSON(res,400,{error:'Invalid prekey.'});
    const now=Date.now(); (deviceBundles[account.id]??={})[deviceId]={deviceId,accountId:account.id,signingPublicKey:{kty:'EC',crv:'P-256',x:signing.x,y:signing.y},signedPrekey:{kty:'EC',crv:'P-256',x:sp.x,y:sp.y},signedPrekeySignature:String(body.signedPrekeySignature),prekeys,updatedAt:now};
    saveState(); return sendJSON(res,200,{ok:true,deviceId,updatedAt:now,prekeyCount:prekeys.length});
  }
  if (req.method === 'GET' && path === '/api/keys/bundle') {
    const account=accountFor(req); if(!account) return sendJSON(res,401,{error:'Invalid session.'});
    const username=String(url.searchParams.get('username')||'').trim().toLowerCase(); const target=usernameIndex.get(username);
    if(!target||target.id===account.id||!connected(account.id,target.id)) return sendJSON(res,404,{error:'Key bundle unavailable.'});
    const bundles=deviceBundles[target.id]||{}; const out=Object.values(bundles).map(b=>({deviceId:b.deviceId,signingPublicKey:b.signingPublicKey,signedPrekey:b.signedPrekey,signedPrekeySignature:b.signedPrekeySignature,prekeys:b.prekeys,updatedAt:b.updatedAt}));
    return out.length?sendJSON(res,200,{username:target.username,devices:out,e2ee:E2EE_ENABLED}):sendJSON(res,404,{error:'No key bundle registered.'});
  }

  if (req.method === 'GET' && path === '/api/validate') {
    const account = accountFor(req);
    return account ? sendJSON(res, 200, { account: publicAccount(account), e2ee: E2EE_ENABLED }) : sendJSON(res, 401, { error: 'Invalid session.' });
  }

  if (req.method === 'POST' && path === '/api/profile') {
    const account = accountFor(req); if (!account) return sendJSON(res, 401, { error: 'Invalid session.' });
    const body = await readBody(req); const name = String(body.name ?? '').trim().slice(0, 24);
    if (!name) return sendJSON(res, 400, { error: 'Name required.' });
    account.name = name; account.initial = name[0].toUpperCase();
    if (ACCENTS[body.accent]) { account.accent = body.accent; Object.assign(account, ACCENTS[body.accent]); }
    saveAccounts();
    const partnerIds = requests.filter((r) => r.status === 'accepted' && (r.from === account.id || r.to === account.id)).map((r) => r.from === account.id ? r.to : r.from);
    emitAccounts({ type: 'account.updated', account: publicAccount(account) }, [account.id, ...partnerIds]);
    return sendJSON(res, 200, { account: publicAccount(account) });
  }

  if (req.method === 'POST' && path === '/api/block') {
    const me=accountFor(req); if(!me) return sendJSON(res,401,{error:'Invalid session.'});
    const body=await readBody(req); const target=usernameIndex.get(String(body.username??'').trim().toLowerCase());
    if(!target || target.id===me.id) return sendJSON(res,400,{error:'Invalid user.'});
    if(!blocks.some(b=>b.blockerId===me.id&&b.blockedId===target.id)) blocks.push({blockerId:me.id,blockedId:target.id,createdAt:Date.now()});
    for(let i=requests.length-1;i>=0;i--) if((requests[i].from===me.id&&requests[i].to===target.id)||(requests[i].from===target.id&&requests[i].to===me.id)) requests.splice(i,1);
    saveState(); return sendJSON(res,200,{ok:true});
  }
  if (req.method === 'POST' && path === '/api/report') {
    const me=accountFor(req); if(!me) return sendJSON(res,401,{error:'Invalid session.'});
    if(!rateLimit(`report:${me.id}`,5,60_000)) return sendJSON(res,429,{error:'Too many reports.'});
    const body=await readBody(req); const target=usernameIndex.get(String(body.username??'').trim().toLowerCase()); const reason=String(body.reason??'').trim().slice(0,80); const details=String(body.details??'').trim().slice(0,1000);
    if(!reason) return sendJSON(res,400,{error:'Report reason required.'});
    reports.push({id:randomUUID(),reporterId:me.id,targetId:target?.id??null,conversationId:String(body.conversationId??'').slice(0,120)||null,reason,details,createdAt:Date.now(),status:'open'}); saveState(); return sendJSON(res,201,{ok:true});
  }

  if (req.method === 'GET' && path === '/api/messages') {
    const account = accountFor(req); if (!account) return sendJSON(res, 401, { error: 'Invalid session.' });
    const conversationId = url.searchParams.get('conversationId') ?? '';
    if (!canAccessConversation(account.id, conversationId)) return sendJSON(res, 403, { error: 'You need permission to chat with this person.' });
    const now = Date.now();
    const messages = (conversations[conversationId] ?? []).filter((m) => !m.expiresAt || m.expiresAt > now);
    return sendJSON(res, 200, { conversationId, messages });
  }

  if (req.method === 'GET' && path === '/api/users/find') {
    const me = accountFor(req); if (!me) return sendJSON(res, 401, { error: 'Invalid session.' });
    const uname = String(url.searchParams.get('username') ?? '').trim().toLowerCase();
    if (!uname) return sendJSON(res, 200, { found: false });
    const account = usernameIndex.get(uname); if (!account) return sendJSON(res, 200, { found: false });
    if (account.id === me.id) return sendJSON(res, 200, { found: true, relation: 'self', account: publicAccount(account) });
    if (connected(me.id, account.id)) return sendJSON(res, 200, { found: true, relation: 'connected', account: publicAccount(account) });
    const pending = (from, to) => requests.find((r) => r.status === 'pending' && r.from === from && r.to === to);
    const outgoing = pending(me.id, account.id); if (outgoing) return sendJSON(res, 200, { found: true, relation: 'outgoing', requestId: outgoing.id, account: { id: account.id, username: account.username } });
    const incoming = pending(account.id, me.id); if (incoming) return sendJSON(res, 200, { found: true, relation: 'incoming', requestId: incoming.id, account: { id: account.id, username: account.username } });
    return sendJSON(res, 200, { found: true, relation: 'none', account: { id: account.id, username: account.username } });
  }

  if (req.method === 'GET' && path === '/api/requests') {
    const me = accountFor(req); if (!me) return sendJSON(res, 401, { error: 'Invalid session.' });
    const usernameOf = (id) => accounts.find((a) => a.id === id)?.username ?? '?';
    const incoming = requests.filter((r) => r.status === 'pending' && r.to === me.id).map((r) => ({ requestId: r.id, createdAt: r.createdAt, user: publicAccount(accounts.find((a) => a.id === r.from)) })).filter((r) => r.user);
    const outgoing = requests.filter((r) => r.status === 'pending' && r.from === me.id).map((r) => ({ requestId: r.id, createdAt: r.createdAt, user: { id: r.to, username: usernameOf(r.to) } }));
    return sendJSON(res, 200, { incoming, outgoing });
  }

  if (req.method === 'POST' && path === '/api/requests') {
    const me = accountFor(req); if (!me) return sendJSON(res, 401, { error: 'Invalid session.' });
    const body = await readBody(req); const toId = String(body.toId ?? ''); if (!/^u-[a-f0-9]{16}$/.test(toId)) return sendJSON(res, 400, { error: 'Invalid recipient.' }); const other = accounts.find((a) => a.id === toId);
    if (!other) return sendJSON(res, 404, { error: 'No such user.' });
    if (other.id === me.id) return sendJSON(res, 400, { error: 'That is you.' });
    if (connected(me.id, other.id)) return sendJSON(res, 400, { error: 'You can already chat.' });
    if (requests.some((r) => r.status === 'pending' && ((r.from === me.id && r.to === other.id) || (r.from === other.id && r.to === me.id)))) return sendJSON(res, 409, { error: 'A request is already pending.' });
    const request = { id: randomUUID(), from: me.id, to: other.id, status: 'pending', createdAt: Date.now() }; requests.push(request); saveRequests();
    emitAccounts({ type: 'request.incoming', request: { ...request }, user: publicAccount(me) }, [other.id]);
    return sendJSON(res, 200, { request, user: { id: other.id, username: other.username } });
  }

  if (req.method === 'POST' && path === '/api/requests/accept') {
    const me = accountFor(req); if (!me) return sendJSON(res, 401, { error: 'Invalid session.' });
    const body = await readBody(req); const request = requests.find((r) => r.id === body.requestId);
    if (!request || request.to !== me.id || request.status !== 'pending') return sendJSON(res, 404, { error: 'No such request.' });
    request.status = 'accepted'; saveRequests();
    const convId = `dm:${[request.from, request.to].sort().join(':')}`; convMeta[convId] = { lastAt: Date.now() }; saveConvMeta();
    const other = publicAccount(accounts.find((a) => a.id === request.from));
    emitAccounts({ type: 'request.accepted', request: { ...request }, user: publicAccount(me) }, [me.id, request.from]);
    return sendJSON(res, 200, { request: { ...request }, account: other });
  }

  if (req.method === 'POST' && path === '/api/requests/decline') {
    const me = accountFor(req); if (!me) return sendJSON(res, 401, { error: 'Invalid session.' });
    const body = await readBody(req); const request = requests.find((r) => r.id === body.requestId);
    if (!request || request.to !== me.id || request.status !== 'pending') return sendJSON(res, 404, { error: 'No such request.' });
    request.status = 'declined'; saveRequests(); emitAccounts({ type: 'request.declined', request: { ...request }, user: publicAccount(me) }, [me.id, request.from]);
    return sendJSON(res, 200, { request: { ...request } });
  }

  if (req.method === 'GET' && path === '/api/recents') {
    const account = accountFor(req); if (!account) return sendJSON(res, 401, { error: 'Invalid session.' });
    const recents = []; const convIds = new Set([...Object.keys(conversations), ...Object.keys(convMeta)]);
    for (const conversationId of convIds) {
      if (!canAccessConversation(account.id, conversationId)) continue;
      const parts = conversationId.split(':'); const partnerId = parts.find((p, i) => i > 0 && p !== account.id) ?? null; if (!partnerId) continue;
      const messages = conversations[conversationId] ?? []; const lastMsg = messages.length ? messages[messages.length - 1].createdAt : 0; const lastAt = Math.max(lastMsg, convMeta[conversationId]?.lastAt ?? 0); if (!lastAt) continue;
      recents.push({ conversationId, partnerId, lastAt });
    }
    recents.sort((a, b) => b.lastAt - a.lastAt); return sendJSON(res, 200, { recents });
  }

  if (req.method === 'POST' && path === '/send') {
    const account = accountFor(req); if (!account) return sendJSON(res, 401, { error: 'Invalid session.' });
    const body = await readBody(req); const event = body.event;
    const clientId = normalizeClientId(body.clientId);
    if (!event || typeof event.type !== 'string' || !CLIENT_EVENTS.has(event.type)) return sendJSON(res, 400, { error: 'Unsupported event.' });
    if (!rateLimit(`send:${account.id}`, 240, 60_000)) return sendJSON(res, 429, { error: 'Too many events.' });
    if (CONVERSATION_EVENTS.has(event.type)) {
      if (!canAccessConversation(account.id, event.conversationId)) return sendJSON(res, 403, { error: 'You need permission to chat with this person.' });
      event.authorId = account.id;
    }
    if (E2EE_ENABLED && event.authorDeviceId && ['draft.started','draft.updated','draft.sent','e2ee.session.init'].includes(event.type)) { const ds=Array.isArray(deviceKeys[account.id])?deviceKeys[account.id]:[]; if(!ds.some(d=>d.deviceId===event.authorDeviceId)) return sendJSON(res,403,{error:'Unknown device.'}); }
    if (event.type === 'user.joined' || event.type === 'user.left' || event.type === 'presence.ping') {
      event.user = publicAccount(account);
    }
    if (event.type === 'e2ee.session.init') {
      if (!E2EE_ENABLED) return sendJSON(res, 400, { error: 'E2EE is disabled.' });
      const ss=event.session;
      if (!ss || typeof ss.targetDeviceId !== 'string' || !/^[0-9a-f-]{20,80}$/i.test(ss.targetDeviceId) || !ss.ephemeralPublicKey || ss.ephemeralPublicKey.kty !== 'EC' || ss.ephemeralPublicKey.crv !== 'P-256' || typeof ss.ephemeralPublicKey.x !== 'string' || typeof ss.ephemeralPublicKey.y !== 'string' || typeof ss.prekeyId !== 'string' || typeof ss.senderDeviceId !== 'string') return sendJSON(res,400,{error:'Invalid E2EE session.'});
      if (event.authorDeviceId && event.authorDeviceId !== ss.senderDeviceId) return sendJSON(res,403,{error:'Device/session mismatch.'}); event.session={targetDeviceId:ss.targetDeviceId,senderDeviceId:ss.senderDeviceId,prekeyId:ss.prekeyId,ephemeralPublicKey:ss.ephemeralPublicKey}; event.authorId=account.id; event.author=publicAccount(account);
      await emitConversation(event, clientId); return sendJSON(res,204,{});
    }
    if (event.type === 'draft.started') {
      if (!event.draft || !/^[A-Za-z0-9_-]{2,80}$/.test(event.draft.id)) return sendJSON(res, 400, { error: 'Invalid draft.' });
      const key = `${event.conversationId}:${event.draft.id}`;
      if (activeDrafts.has(key)) return sendJSON(res, 409, { error: 'Draft already exists.' });
      const visibility = ['LIVE','PRIVATE','OFF'].includes(event.draft.visibility) ? event.draft.visibility : 'LIVE';
      const text = safeText(event.draft.text);
      const now = Date.now();
      activeDrafts.set(key, { authorId: account.id, visibility, rev: 0, expiresAt: now + DRAFT_TTL_MS });
      event.draft = { id: event.draft.id, conversationId: event.conversationId, authorId: account.id, text, visibility, status: 'WRITING', cursorPosition: Math.max(0, Math.min(Number(event.draft.cursorPosition) || 0, text.length)), updatedAt: now, startedAt: now, rev: 0, expiresAt: now + DRAFT_TTL_MS };
      event.author = publicAccount(account);
      if (visibility !== 'LIVE') delete event.draft.text;
    }
    if (event.type === 'draft.updated') {
      if (!/^[A-Za-z0-9_-]{2,80}$/.test(event.draftId)) return sendJSON(res, 400, { error: 'Invalid draft.' });
      const key = `${event.conversationId}:${event.draftId}`;
      const draft = activeDrafts.get(key);
      if (!draft || draft.authorId !== account.id || draft.expiresAt <= Date.now()) return sendJSON(res, 403, { error: 'Draft is not yours or has expired.' });
      const nextRev = Number(event.rev);
      if (!Number.isInteger(nextRev) || nextRev < draft.rev || nextRev > draft.rev + 1) return sendJSON(res, 409, { error: 'Draft revision conflict.' });
      draft.rev = nextRev;
      draft.expiresAt = Date.now() + DRAFT_TTL_MS;
      if (['LIVE','PRIVATE','OFF'].includes(event.visibility)) draft.visibility = event.visibility;
      event.updatedAt = Date.now(); event.authorId = account.id; event.visibility = draft.visibility;
      event.text = safeText(event.text);
      if (draft.visibility !== 'LIVE') delete event.text;
      event.cursorPosition = Math.max(0, Math.min(Number(event.cursorPosition) || 0, 4000));
      event.rev = draft.rev;
      event.author = publicAccount(account);
    }
    if (event.type === 'draft.paused' || event.type === 'draft.discarded' || event.type === 'draft.deleted') {
      if (typeof event.draftId === 'string') { const key = `${event.conversationId}:${event.draftId}`; const draft = activeDrafts.get(key); if (!draft || draft.authorId !== account.id) return sendJSON(res, 403, { error: 'Draft is not yours.' }); activeDrafts.delete(key); }
      event.updatedAt = Date.now(); event.authorId = account.id;
    }
    if (event.type === 'draft.resync') { /* request contains no content; author receives it only through the same authorized conversation */ }
    if (event.type === 'draft.sent') {
      const text = safeText(event.message?.text);
      if (!text.trim()) return sendJSON(res, 400, { error: 'Message text required.' });
      const convId = event.conversationId;
      const message = { id: randomUUID(), conversationId: convId, authorId: account.id, text, createdAt: Date.now(), via: 'draft', ephemeral: true, expiresAt: Date.now() + MESSAGE_TTL_MS, author: publicAccount(account) };
      conversations[convId] = conversations[convId] ?? [];
      if (!conversations[convId].some((m) => m.id === message.id)) conversations[convId].push(message);
      convMeta[convId] = { lastAt: message.createdAt }; saveConvos(); saveConvMeta();
      event.message = message; event.authorId = account.id; event.author = publicAccount(account); delete event.expiresAt;
    }
    await emitConversation(event, clientId);
    return sendJSON(res, 204, {});
  }
  return sendJSON(res, 404, { error: 'Not found' });
}

async function handleStream(req, res, url) {
  const account = accountFor(req); const clientId = normalizeClientId(url.searchParams.get('clientId'));
  if (!account) { res.writeHead(401, { 'Content-Type': 'text/plain' }); res.end('unauthorized'); return; }
  const accountConnections=[...clients.values()].filter(c=>c.accountId===account.id).length;
  if(clients.size>=MAX_CONNECTIONS_GLOBAL || accountConnections>=MAX_CONNECTIONS_PER_ACCOUNT){ return sendJSON(res,429,{error:'Connection limit reached.'},{'Retry-After':'30'}); }
  if (clients.has(clientId)) { try { clients.get(clientId).res.end(); } catch {} clients.delete(clientId); }
  res.writeHead(200, { ...securityHeaders(requestId(req)), 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  clients.set(clientId, { res, accountId: account.id, transport: 'sse' });
  res.write(`data: ${JSON.stringify({ type: 'stream.open', tabId: clientId, seq: globalSeq })}\n\n`);
  await replayForClient(clientId, Math.max(0, Number(url.searchParams.get('lastSeq')) || 0));
  const heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25_000);
  req.on('close', () => { clearInterval(heartbeat); if (clients.get(clientId)?.res === res) clients.delete(clientId); });
}


async function processRealtimeEvent(account, event, clientId) {
  if (!event || typeof event.type !== 'string' || !CLIENT_EVENTS.has(event.type)) return { error: 'Unsupported event.' };
  if (!rateLimit(`send:${account.id}`, MAX_EVENT_PER_MINUTE, 60_000)) return { error: 'Too many events.' };
  const cid=String(event.eventId??event.id??''); if(cid){ if(eventDedup.has(`${account.id}:${cid}`)) return { ok:true, duplicate:true }; eventDedup.set(`${account.id}:${cid}`,Date.now()); }
  if(event.type==='draft.started' && [...activeDrafts.values()].filter(d=>d.authorId===account.id).length>=MAX_DRAFTS_PER_ACCOUNT) return {error:'Too many active drafts.'};
  if (CONVERSATION_EVENTS.has(event.type)) {
    if (!canAccessConversation(account.id, event.conversationId)) return { error: 'You need permission to chat with this person.' };
    event.authorId = account.id;
  }
  if (E2EE_ENABLED && event.authorDeviceId && ['draft.started','draft.updated','draft.sent','e2ee.session.init'].includes(event.type)) { const ds=Array.isArray(deviceKeys[account.id])?deviceKeys[account.id]:[]; if(!ds.some(d=>d.deviceId===event.authorDeviceId)) return {error:'Unknown device.'}; }
  if (event.type === 'user.joined' || event.type === 'user.left' || event.type === 'presence.ping') event.user = publicAccount(account);
  if (event.type === 'e2ee.session.init') {
    if (!E2EE_ENABLED) return { error: 'E2EE is disabled.' };
    const s = event.session;
    if (!s || typeof s.targetDeviceId !== 'string' || !/^[0-9a-f-]{20,80}$/i.test(s.targetDeviceId) ||
        !s.ephemeralPublicKey || s.ephemeralPublicKey.kty !== 'EC' || s.ephemeralPublicKey.crv !== 'P-256' ||
        typeof s.ephemeralPublicKey.x !== 'string' || typeof s.ephemeralPublicKey.y !== 'string' ||
        typeof s.prekeyId !== 'string' || typeof s.senderDeviceId !== 'string') return { error: 'Invalid E2EE session.' };
    if (event.authorDeviceId && event.authorDeviceId !== s.senderDeviceId) return {error:'Device/session mismatch.'}; event.session = { targetDeviceId:s.targetDeviceId, senderDeviceId:s.senderDeviceId, prekeyId:s.prekeyId, ephemeralPublicKey:s.ephemeralPublicKey };
    event.authorId = account.id;
    event.author = publicAccount(account);
    await emitConversation(event, clientId);
    return { ok:true };
  }
  if (event.type === 'draft.started') {
    if (!event.draft || !/^[A-Za-z0-9_-]{2,80}$/.test(event.draft.id)) return { error: 'Invalid draft.' };
    const key = `${event.conversationId}:${event.draft.id}`;
    if (activeDrafts.has(key)) return { error: 'Draft already exists.' };
    const visibility = ['LIVE','PRIVATE','OFF'].includes(event.draft.visibility) ? event.draft.visibility : 'LIVE';
    const text = safeText(event.draft.text); const now = Date.now();
    activeDrafts.set(key, { authorId: account.id, visibility, rev: 0, expiresAt: now + DRAFT_TTL_MS });
    event.draft = { id:event.draft.id, conversationId:event.conversationId, authorId:account.id, visibility, status:'WRITING', cursorPosition:Math.max(0,Math.min(Number(event.draft.cursorPosition)||0,text.length)), updatedAt:now, startedAt:now, rev:0, expiresAt:now+DRAFT_TTL_MS };
    if (E2EE_ENABLED) { if (!event.authorDeviceId) return {error:'Device identity required.'}; if (!event.draft.encrypted) return {error:'Encrypted draft required.'}; event.draft.encrypted=event.draft.encrypted; delete event.draft.text; } else event.draft.text=text;
    event.author = publicAccount(account); if (visibility !== 'LIVE') { delete event.draft.text; delete event.draft.encrypted; }
  }
  if (event.type === 'draft.updated') {
    if (!/^[A-Za-z0-9_-]{2,80}$/.test(event.draftId)) return { error: 'Invalid draft.' };
    const key=`${event.conversationId}:${event.draftId}`, draft=activeDrafts.get(key);
    if (!draft || draft.authorId!==account.id || draft.expiresAt<=Date.now()) return { error:'Draft is not yours or has expired.' };
    const nextRev=Number(event.rev); if(!Number.isInteger(nextRev)||nextRev<draft.rev||nextRev>draft.rev+1) return { error:'Draft revision conflict.' };
    draft.rev=nextRev; draft.expiresAt=Date.now()+DRAFT_TTL_MS; if(['LIVE','PRIVATE','OFF'].includes(event.visibility)) draft.visibility=event.visibility;
    event.updatedAt=Date.now(); event.authorId=account.id; event.visibility=draft.visibility; if (E2EE_ENABLED) { if(!event.authorDeviceId) return {error:'Device identity required.'}; if(!event.encrypted) return {error:'Encrypted draft required.'}; delete event.text; } else event.text=safeText(event.text); if(draft.visibility!=='LIVE'){ delete event.text; delete event.encrypted; }
    event.cursorPosition=Math.max(0,Math.min(Number(event.cursorPosition)||0,4000)); event.rev=draft.rev; event.author=publicAccount(account);
  }
  if (['draft.paused','draft.discarded','draft.deleted'].includes(event.type)) {
    if(typeof event.draftId==='string'){ const key=`${event.conversationId}:${event.draftId}`, draft=activeDrafts.get(key); if(!draft||draft.authorId!==account.id) return {error:'Draft is not yours.'}; activeDrafts.delete(key); }
    event.updatedAt=Date.now(); event.authorId=account.id;
  }
  if (event.type === 'draft.sent') {
    const convId=event.conversationId; const now=Date.now();
    if (E2EE_ENABLED) {
      if (!event.authorDeviceId) return {error:'Device identity required.'};
      if (!event.message?.encrypted || !(typeof event.message.encrypted.ct === 'string' || (event.message.encrypted.mode === 'ratchet' && Array.isArray(event.message.encrypted.envelopes)))) return {error:'Encrypted message required.'};
      const message={id:randomUUID(),conversationId:convId,authorId:account.id,encrypted:event.message.encrypted,createdAt:now,via:'draft',ephemeral:true,expiresAt:now+MESSAGE_TTL_MS,author:publicAccount(account)};
      conversations[convId]=conversations[convId]??[]; conversations[convId].push(message); convMeta[convId]={lastAt:message.createdAt}; saveState();
      event.message=message;
    } else {
      const text=safeText(event.message?.text); if(!text.trim()) return {error:'Message text required.'};
      const message={id:randomUUID(),conversationId:convId,authorId:account.id,text,createdAt:now,via:'draft',ephemeral:true,expiresAt:now+MESSAGE_TTL_MS,author:publicAccount(account)};
      conversations[convId]=conversations[convId]??[]; conversations[convId].push(message); convMeta[convId]={lastAt:message.createdAt}; saveState(); event.message=message;
    }
    event.authorId=account.id; event.author=publicAccount(account); delete event.expiresAt;
  }
  await emitConversation(event, clientId);
  return { ok:true };
}

async function handleWebSocketUpgrade(req, socket, head) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname !== '/ws') return false;
  const account = accountFor(req); if (!account) { socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return true; }
  const accountConnections=[...clients.values()].filter(c=>c.accountId===account.id).length;
  if(clients.size>=MAX_CONNECTIONS_GLOBAL || accountConnections>=MAX_CONNECTIONS_PER_ACCOUNT){ socket.end('HTTP/1.1 429 Too Many Connections\r\nRetry-After: 30\r\n\r\n'); return true; }
  const key = req.headers['sec-websocket-key'];
  if (!key || req.headers.upgrade?.toLowerCase() !== 'websocket') { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return true; }
  const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const clientId=normalizeClientId(url.searchParams.get('clientId')); if(clients.has(clientId)){ try{clients.get(clientId).socket?.end();clients.get(clientId).res?.end()}catch{} clients.delete(clientId); }
  const client={socket,accountId:account.id,transport:'ws'}; clients.set(clientId,client);
  sendClient(client,{type:'sync.ready',tabId:clientId,seq:globalSeq});
  replayForClient(clientId, Math.max(0, Number(url.searchParams.get('lastSeq'))||0));
  let buf=Buffer.alloc(0);
  const cleanup=()=>{if(clients.get(clientId)===client)clients.delete(clientId)};
  socket.on('close',cleanup); socket.on('error',cleanup);
  socket.on('data',async (chunk)=>{ buf=Buffer.concat([buf,chunk]); while(buf.length>=2){ const b1=buf[0],b2=buf[1], opcode=b1&15, masked=!!(b2&128); let len=b2&127, off=2; if(len===126){if(buf.length<4)break;len=buf.readUInt16BE(2);off=4}else if(len===127){if(buf.length<10)break;len=Number(buf.readBigUInt64BE(2));off=10} if(len>1024*1024) return socket.destroy(); const need=off+(masked?4:0)+len; if(buf.length<need)break; let mask; if(masked){mask=buf.subarray(off,off+4);off+=4} const payload=Buffer.from(buf.subarray(off,off+len));buf=buf.subarray(need); if(masked)for(let i=0;i<payload.length;i++)payload[i]^=mask[i%4]; if(opcode===8){socket.end();return} if(opcode===9){const pong=Buffer.concat([Buffer.from([0x8A,payload.length]),payload]);socket.write(pong);continue} if(opcode!==1)continue; let msg;try{msg=JSON.parse(payload.toString())}catch{continue} if(msg.type==='sync.resume'){await replayForClient(clientId,Number(msg.lastSeq)||0);continue} const result=await processRealtimeEvent(account,msg.event,clientId); sendClient(client,{type:'event.ack',cid:msg.cid??null,ok:!result.error,error:result.error??null}); } });
  return true;
}

const MIME = { '.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon' };
function serveStatic(req, res, url) {
  let pathname; try { pathname = decodeURIComponent(url.pathname); } catch { res.writeHead(400).end('Bad path'); return; }
  if (pathname === '/') pathname = '/index.html';
  if (pathname === '/data' || pathname.startsWith('/data/')) return res.writeHead(404).end('Not found');
  const filePath = normalize(join(ROOT, pathname));
  if (!filePath.startsWith(ROOT.endsWith(sep) ? ROOT : ROOT + sep)) return res.writeHead(403).end('Forbidden');
  try { res.writeHead(200, { 'Content-Type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(readFileSync(filePath)); }
  catch { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); }
}

setInterval(() => {
  const now = Date.now(); let dirty = false;
  for (const [convId, messages] of Object.entries(conversations)) {
    const expired = messages.filter((m) => m.expiresAt && m.expiresAt <= now);
    if (!expired.length) continue;
    conversations[convId] = messages.filter((m) => !(m.expiresAt && m.expiresAt <= now)); dirty = true;
    for (const message of expired) emitConversation({ type: 'message.expired', conversationId: convId, message });
  }
  for (const [token, s] of Object.entries(sessionTokens)) if (s.expiresAt <= now) { delete sessionTokens[token]; dirty = true; }
  if (dirty) { saveConvos(); saveSessions(); }
}, 1000);

const httpServer = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/events' && req.method === 'GET') return await handleStream(req, res, url);
    if (url.pathname.startsWith('/api/') || url.pathname === '/send' || url.pathname === '/healthz' || url.pathname === '/readyz') return await handleApi(req, res, url);
    return serveStatic(req, res, url);
  } catch (err) { try { sendJSON(res, 500, { error: 'Server error.' }); } catch {} }
});
httpServer.on('upgrade',async (req,socket,head)=>{ if(!(await handleWebSocketUpgrade(req,socket,head))) socket.end('HTTP/1.1 404 Not Found\r\n\r\n'); });
httpServer.listen(PORT, '0.0.0.0', () => console.log(`LIVE v0.8 hardened server (distributed realtime + abuse controls) → http://localhost:${PORT} (${process.env.DATABASE_URL ? 'database mode' : 'JSON compatibility mode'})`));
