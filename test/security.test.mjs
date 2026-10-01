import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, cpSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let root, child, base;
const cookieJar = new Map();
function cookiesFor(name) { return cookieJar.get(name) || ''; }
function rememberCookie(name, res) {
  const raw = res.headers.get('set-cookie');
  if (!raw) return;
  const token = raw.split(';')[0];
  cookieJar.set(name, token);
}
async function req(name, path, options = {}) {
  const headers = new Headers(options.headers || {});
  const cookie = cookiesFor(name);
  if (cookie) headers.set('Cookie', cookie);
  if (options.method && options.method !== 'GET') headers.set('Origin', base);
  const res = await fetch(base + path, { ...options, headers });
  rememberCookie(name, res);
  let data = null; try { data = await res.json(); } catch {}
  return { res, data };
}

async function acceptRequestAs(name, requestId) {
  const r = await req(name, '/api/requests/accept', {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({requestId})});
  assert.equal(r.res.status, 200); return r.data;
}
async function openStream(name) {
  const headers = new Headers();
  const cookie = cookiesFor(name); if (cookie) headers.set('Cookie', cookie);
  return fetch(base + '/events?clientId=' + encodeURIComponent(name + '-client-1234'), {headers});
}
async function readOne(stream, predicate, timeout=1500) {
  const reader = stream.body.getReader(); const decoder = new TextDecoder(); let buf='';
  const deadline = Date.now()+timeout;
  while (Date.now() < deadline) {
    const result = await Promise.race([reader.read(), new Promise(resolve=>setTimeout(()=>resolve({timeout:true}), Math.max(1, deadline-Date.now()))) ]);
    if (result.timeout) throw new Error('stream timeout');
    if (result.done) throw new Error('stream closed');
    buf += decoder.decode(result.value,{stream:true});
    const frames = buf.split('\n\n'); buf = frames.pop();
    for (const frame of frames) for (const line of frame.split('\n')) if (line.startsWith('data: ')) {
      const env=JSON.parse(line.slice(6)); if (predicate(env)) { reader.cancel(); return env; }
    }
  }
  throw new Error('stream timeout');
}


async function ensureConnected(aName, bName) {
  const target = await req(aName, `/api/users/find?username=${encodeURIComponent(bName)}`);
  const out = await req(aName, '/api/requests', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({toId:target.data.account.id})});
  if (out.res.status === 200) { await acceptRequestAs(bName, out.data.request.id); return; }
  if (out.res.status === 409) {
    const pending = await req(bName, '/api/requests');
    const incoming = pending.data.incoming?.find(x => x.user?.username === aName);
    if (incoming) await acceptRequestAs(bName, incoming.requestId);
  }
}

async function signup(name, username) {
  const r = await req(name, '/api/signup', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({username,name:username,password:'strong-pass-123'}) });
  assert.equal(r.res.status, 200); return r.data.account;
}

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'live-secure-'));
  cpSync(new URL('../', import.meta.url), root, { recursive:true });
  for (const f of ['accounts.json','conversations.json','sessions.json','conv-meta.json','requests.json']) writeFileSync(join(root,'data',f), f === 'sessions.json' ? '{}' : f === 'conversations.json' || f === 'conv-meta.json' ? '{}' : '[]');
  child = spawn(process.execPath, ['server.mjs'], { cwd:root, env:{...process.env, PORT:'5187', NODE_ENV:'test', LIVE_E2EE:'1'}, stdio:['ignore','pipe','pipe'] });
  base = 'http://127.0.0.1:5187';
  await new Promise((resolve,reject) => { const t=setTimeout(()=>reject(new Error('server timeout')),5000); child.stdout.on('data', d => { if (String(d).includes('hardened server')) { clearTimeout(t); resolve(); } }); child.on('error', reject); });
});
after(() => { child?.kill('SIGTERM'); if (root) rmSync(root,{recursive:true,force:true}); });

test('database files are not statically exposed', async () => {
  const r = await fetch(base + '/data/accounts.json');
  assert.equal(r.status, 404);
});

test('signup creates HttpOnly cookie and no JS token', async () => {
  const a = await signup('alice','alice');
  assert.match(cookiesFor('alice'), /HttpOnly|live_session/);
  assert.equal(a.username, 'alice');
  const raw = readFileSync(join(root,'data','sessions.json'),'utf8');
  assert.doesNotMatch(raw, /token/);
});

test('second user can be found only by exact username and is not a directory', async () => {
  await signup('bob','bob');
  const r = await req('alice','/api/users/find?username=bob');
  assert.equal(r.res.status,200);
  assert.equal(r.data.account.username,'bob');
  assert.equal(r.data.account.name, undefined);
  const directory = await req('alice','/api/accounts');
  assert.equal(directory.res.status,404);
});

test('login accepts strong password and session is cookie-backed', async () => {
  cookieJar.delete('alice2');
  const r = await req('alice2','/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'alice',password:'strong-pass-123'})});
  assert.equal(r.res.status,200);
  const v = await req('alice2','/api/validate');
  assert.equal(v.res.status,200);
});

test('unauthorized send cannot forge another user', async () => {
  const bob = await req('bob','/api/users/find?username=alice');
  const aliceId = bob.data.account.id;
  const alice = await req('alice','/api/users/find?username=bob');
  const bobId = alice.data.account.id;
  const conv = `dm:${[aliceId,bobId].sort().join(':')}`;
  const r = await req('alice','/send',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({event:{type:'draft.updated',conversationId:conv,authorId:bobId,draftId:'x',text:'forged'}})});
  assert.equal(r.res.status,403);
});

test('tokens in query strings do not authenticate', async () => {
  const r = await fetch(base + '/api/validate?token=anything');
  assert.equal(r.status,401);
});


test('realtime events are routed only to authorized conversation participants', async () => {
  const a = await signup('alice7','alice7'); const b = await signup('bob7','bob7'); const c = await signup('charlie7','charlie7');
  const reqOut = await req('alice7','/api/requests',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({toId:b.id})});
  assert.equal(reqOut.res.status,200);
  await acceptRequestAs('bob7', reqOut.data.request.id);
  const sBob = await openStream('bob7'); const sCharlie = await openStream('charlie7');
  const conv = `dm:${[a.id,b.id].sort().join(':')}`;
  const started = await req('alice7','/send',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({clientId:'alice7-client-1234',event:{type:'draft.started',conversationId:conv,draft:{id:'d1',text:'h',visibility:'LIVE'}}})});
  assert.equal(started.res.status,204);
  const send = await req('alice7','/send',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({clientId:'alice7-client-1234',event:{type:'draft.updated',conversationId:conv,draftId:'d1',authorId:b.id,rev:1,text:'hello bob',visibility:'LIVE'}})});
  assert.equal(send.res.status,204);
  const got = await readOne(sBob, e=>e.type==='draft.updated' && e.draftId==='d1');
  assert.equal(got.authorId, a.id); assert.equal(got.text,'hello bob');
  await assert.rejects(() => readOne(sCharlie,e=>e.type==='draft.updated'&&e.draftId==='d1',250), /timeout/);
  assert.ok(c.id);
});

test('private drafts never cross the server boundary as text', async () => {
  await ensureConnected('alice','bob');
  const alice = await req('alice','/api/validate');
  const bob = await req('bob','/api/validate');
  const conv = `dm:${[alice.data.account.id,bob.data.account.id].sort().join(':')}`;
  const sBob = await openStream('bob');
  const started = await req('alice','/send',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({clientId:'alice-client-1234',event:{type:'draft.started',conversationId:conv,draft:{id:'private1',text:'SECRET',visibility:'PRIVATE'}}})});
  assert.equal(started.res.status,204);
  const r = await req('alice','/send',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({clientId:'alice-client-1234',event:{type:'draft.updated',conversationId:conv,draftId:'private1',authorId:bob.data.account.id,rev:1,text:'SECRET',visibility:'PRIVATE'}})});
  assert.equal(r.res.status,204);
  const got = await readOne(sBob,e=>e.type==='draft.updated'&&e.draftId==='private1');
  assert.equal(got.authorId,alice.data.account.id); assert.equal(got.text,undefined);
});



test('security headers are present on API responses', async () => {
  const r = await fetch(base + '/api/validate');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.ok(r.headers.get('content-security-policy'));
  assert.ok(r.headers.get('x-request-id'));
});

test("a user cannot update another user's active draft", async () => {
  await ensureConnected('alice','bob');
  const alice = await req('alice','/api/validate');
  const bob = await req('bob','/api/validate');
  const conv = `dm:${[alice.data.account.id,bob.data.account.id].sort().join(':')}`;
  const started = await req('alice','/send',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({clientId:'alice-client-1234',event:{type:'draft.started',conversationId:conv,draft:{id:'owned1',text:'hello',visibility:'LIVE'}}})});
  assert.equal(started.res.status,204);
  const forged = await req('bob','/send',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({clientId:'bob-client-1234',event:{type:'draft.updated',conversationId:conv,draftId:'owned1',authorId:alice.data.account.id,rev:1,text:'forged',visibility:'LIVE'}})});
  assert.equal(forged.res.status,403);
});

test('device identity registration exposes fingerprint and verification state', async () => {
  await ensureConnected('alice','bob');
  const key={kty:'EC',crv:'P-256',x:'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',y:'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'};
  const reg=await req('alice','/api/keys',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({deviceId:'11111111-1111-1111-1111-111111111111',publicKey:key})});
  assert.equal(reg.res.status,200); assert.equal(reg.data.verified,false); assert.match(reg.data.fingerprint,/^[0-9a-f]{32}$/);
  const list=await req('bob','/api/keys?username=alice'); assert.equal(list.res.status,200); assert.equal(list.data.devices[0].fingerprint,reg.data.fingerprint); assert.equal(list.data.devices[0].verified,false);
  const verify=await req('bob','/api/keys/verify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'alice',deviceId:reg.data.deviceId,verified:true})});
  assert.equal(verify.res.status,200); assert.equal(verify.data.verified,true);
});

test('server assigns ephemeral message expiry and author identity', async () => {
  await ensureConnected('alice','bob');
  const alice = await req('alice','/api/validate');
  const bob = await req('bob','/api/validate');
  const conv = `dm:${[alice.data.account.id,bob.data.account.id].sort().join(':')}`;
  const sBob = await openStream('bob'); const before=Date.now();
  const r = await req('alice','/send',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({clientId:'alice-client-1234',event:{type:'draft.sent',conversationId:conv,authorId:bob.data.account.id,message:{id:'m1',authorId:bob.data.account.id,text:'server owned',expiresAt:9999999999999}}})});
  assert.equal(r.res.status,204);
  const got = await readOne(sBob,e=>e.type==='draft.sent'&&e.message?.text==='server owned');
  assert.notEqual(got.message.id,'m1');
  assert.equal(got.message.authorId,alice.data.account.id);
  assert.ok(got.message.expiresAt >= before + 7000 && got.message.expiresAt <= Date.now()+9000);
});
