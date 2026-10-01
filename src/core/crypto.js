/* LIVE v0.9 experimental E2EE primitives.
 *
 * Design:
 * - Each browser/device owns a P-256 ECDH identity key pair.
 * - Only the public key is registered with LIVE.
 * - A DM key is derived locally from the two public identities using ECDH + HKDF.
 * - Payloads use AES-256-GCM with a fresh random 96-bit nonce per payload.
 *
 * This is an experimental protocol foundation, not a completed audited
 * Signal-style protocol: device verification, prekeys, ratcheting,
 * multi-device key distribution and account recovery are intentionally next.
 */
const DB_NAME = 'live-e2ee-v1';
const STORE = 'identity';
const KEY_ID = 'device-keypair';
const DEVICE_ID_KEY = 'device-id';
const INFO = new TextEncoder().encode('LIVE E2EE v0.9 DM payload');

const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const unb64 = (s) => { const p=s.replace(/-/g,'+').replace(/_/g,'/'); const pad='='.repeat((4-p.length%4)%4); return Uint8Array.from(atob(p+pad), c=>c.charCodeAt(0)); };

function openDb() {
  return new Promise((resolve,reject)=>{
    const r=indexedDB.open(DB_NAME,1);
    r.onupgradeneeded=()=>r.result.createObjectStore(STORE);
    r.onsuccess=()=>resolve(r.result); r.onerror=()=>reject(r.error);
  });
}
async function loadKeyPair() {
  const db=await openDb();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(STORE,'readonly'); const req=tx.objectStore(STORE).get(KEY_ID);
    req.onsuccess=()=>resolve(req.result||null); req.onerror=()=>reject(req.error);
  });
}
async function loadDeviceId() {
  const db=await openDb();
  return new Promise((resolve,reject)=>{ const tx=db.transaction(STORE,'readonly'); const req=tx.objectStore(STORE).get(DEVICE_ID_KEY); req.onsuccess=()=>resolve(req.result||null); req.onerror=()=>reject(req.error); });
}
async function saveDeviceId(id) {
  const db=await openDb();
  return new Promise((resolve,reject)=>{ const tx=db.transaction(STORE,'readwrite'); tx.objectStore(STORE).put(id,DEVICE_ID_KEY); tx.oncomplete=()=>resolve(); tx.onerror=()=>reject(tx.error); });
}

async function saveKeyPair(pair) {
  const db=await openDb();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(STORE,'readwrite'); tx.objectStore(STORE).put(pair,KEY_ID);
    tx.oncomplete=()=>resolve(); tx.onerror=()=>reject(tx.error);
  });
}

export async function getIdentity() {
  let pair=await loadKeyPair();
  let deviceId=await loadDeviceId();
  if(!deviceId){ deviceId=crypto.randomUUID(); await saveDeviceId(deviceId); }
  if(!pair){
    pair=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
    await saveKeyPair(pair);
  }
  const publicKey=await crypto.subtle.exportKey('jwk',pair.publicKey);
  const fingerprint=await publicKeyFingerprint(publicKey);
  return { pair, publicKey, deviceId, fingerprint };
}

export async function publicKeyFingerprint(jwk) {
  const canonical=JSON.stringify({kty:jwk.kty,crv:jwk.crv,x:jwk.x,y:jwk.y});
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest)).map(x=>x.toString(16).padStart(2,'0')).join('').slice(0,32);
}

async function deriveKey(privateKey, peerJwk, conversationId) {
  const peer=await crypto.subtle.importKey('jwk',peerJwk,{name:'ECDH',namedCurve:'P-256'},false,[]);
  const bits=await crypto.subtle.deriveBits({name:'ECDH',public:peer},privateKey,256);
  const hkdf=await crypto.subtle.importKey('raw',bits,'HKDF',false,['deriveKey']);
  const salt=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`LIVE:${conversationId}`));
  return crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt,info:INFO},hkdf,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}

export async function encryptForConversation(identity, peerJwk, conversationId, value) {
  const key=await deriveKey(identity.pair.privateKey,peerJwk,conversationId);
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const plaintext=new TextEncoder().encode(JSON.stringify(value));
  const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,plaintext);
  return { v:1, alg:'ECDH-P256+HKDF-SHA256+AES-256-GCM', iv:b64(iv), ct:b64(ciphertext) };
}

export async function decryptForConversation(identity, peerJwk, conversationId, payload) {
  if(!payload || payload.v!==1 || payload.alg!=='ECDH-P256+HKDF-SHA256+AES-256-GCM') throw new Error('Unsupported encrypted payload');
  const key=await deriveKey(identity.pair.privateKey,peerJwk,conversationId);
  const plaintext=await crypto.subtle.decrypt({name:'AES-GCM',iv:unb64(payload.iv)},key,unb64(payload.ct));
  return JSON.parse(new TextDecoder().decode(plaintext));
}

const BUNDLE_DB_VERSION = 2;
const SIGNING_KEY_ID = 'device-signing-keypair';
const PREKEYS_ID = 'device-prekeys';

async function getStoreValue(key, version=BUNDLE_DB_VERSION) {
  return new Promise((resolve,reject)=>{
    const r=indexedDB.open(DB_NAME,version);
    r.onupgradeneeded=()=>{ if(!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE); };
    r.onsuccess=()=>{ const db=r.result; const tx=db.transaction(STORE,'readonly'); const q=tx.objectStore(STORE).get(key); q.onsuccess=()=>resolve(q.result??null); q.onerror=()=>reject(q.error); };
    r.onerror=()=>reject(r.error);
  });
}
async function putStoreValue(key,value,version=BUNDLE_DB_VERSION) {
  return new Promise((resolve,reject)=>{
    const r=indexedDB.open(DB_NAME,version);
    r.onupgradeneeded=()=>{ if(!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE); };
    r.onsuccess=()=>{ const db=r.result; const tx=db.transaction(STORE,'readwrite'); tx.objectStore(STORE).put(value,key); tx.oncomplete=()=>resolve(); tx.onerror=()=>reject(tx.error); };
    r.onerror=()=>reject(r.error);
  });
}
const canonicalJwk = (jwk) => JSON.stringify({kty:jwk.kty,crv:jwk.crv,x:jwk.x,y:jwk.y});
async function signText(privateKey,text){ const sig=await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},privateKey,new TextEncoder().encode(text)); return b64(sig); }
async function verifyText(publicKey,text,signature){ const key=await crypto.subtle.importKey('jwk',publicKey,{name:'ECDSA',namedCurve:'P-256'},false,['verify']); return crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},key,unb64(signature),new TextEncoder().encode(text)); }

export async function getDeviceBundle(identity, count=20) {
  let signing=await getStoreValue(SIGNING_KEY_ID);
  if(!signing){ signing=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']); await putStoreValue(SIGNING_KEY_ID,signing); }
  const signingPublicKey=await crypto.subtle.exportKey('jwk',signing.publicKey);
  const existing=await getStoreValue(PREKEYS_ID) || [];
  const prekeys=Array.isArray(existing)?existing:[];
  while(prekeys.length<Math.max(5,Math.min(count,50))){
    const pair=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
    prekeys.push({id:crypto.randomUUID(),publicKey:await crypto.subtle.exportKey('jwk',pair.publicKey),privateKey:await crypto.subtle.exportKey('jwk',pair.privateKey)});
  }
  await putStoreValue(PREKEYS_ID,prekeys);
  const signedPrekey=prekeys[0].publicKey;
  const signedPrekeySignature=await signText(signing.privateKey,canonicalJwk(signedPrekey));
  return {deviceId:identity.deviceId,signingPublicKey,signedPrekey,signedPrekeySignature,prekeys:prekeys.map(({id,publicKey})=>({id,...publicKey}))};
}

export async function verifyDeviceBundle(bundle) {
  if(!bundle?.signingPublicKey||!bundle?.signedPrekey||typeof bundle.signedPrekeySignature!=='string') return false;
  return verifyText(bundle.signingPublicKey,canonicalJwk(bundle.signedPrekey),bundle.signedPrekeySignature);
}


export async function establishRatchetSession(identity, bundle, conversationId) {
  if (!(await verifyDeviceBundle(bundle))) throw new Error('Invalid signed prekey bundle');
  const ephemeral=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
  const peer=await crypto.subtle.importKey('jwk',bundle.signedPrekey,{name:'ECDH',namedCurve:'P-256'},false,[]);
  const bits=await crypto.subtle.deriveBits({name:'ECDH',public:peer},ephemeral.privateKey,256);
  const salt=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`LIVE:ratchet:${conversationId}:${bundle.deviceId}`));
  const hk=await crypto.subtle.importKey('raw',bits,'HKDF',false,['deriveBits']);
  const material=await crypto.subtle.deriveBits({name:'HKDF',hash:'SHA-256',salt,info:new TextEncoder().encode('LIVE E2EE v0.13 ratchet bootstrap')},hk,512);
  const bytes=new Uint8Array(material);
  return {
    deviceId:bundle.deviceId,
    prekeyId:bundle.prekeys?.[0]?.id??null,
    ephemeralPublicKey:await crypto.subtle.exportKey('jwk',ephemeral.publicKey),
    sendChainKey:bytes.slice(0,32),
    recvChainKey:bytes.slice(32,64),
  };
}

export async function acceptRatchetSession(identity, session, conversationId) {
  const prekeys=await getStoreValue(PREKEYS_ID)||[];
  const record=prekeys.find(p=>p.id===session.prekeyId)||prekeys[0]; if(!record) throw new Error('No local prekey available');
  const privateKey=await crypto.subtle.importKey('jwk',record.privateKey,{name:'ECDH',namedCurve:'P-256'},false,['deriveBits']);
  const peer=await crypto.subtle.importKey('jwk',session.ephemeralPublicKey,{name:'ECDH',namedCurve:'P-256'},false,[]);
  const bits=await crypto.subtle.deriveBits({name:'ECDH',public:peer},privateKey,256);
  const salt=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`LIVE:ratchet:${conversationId}:${identity.deviceId}`));
  const hk=await crypto.subtle.importKey('raw',bits,'HKDF',false,['deriveBits']);
  const material=await crypto.subtle.deriveBits({name:'HKDF',hash:'SHA-256',salt,info:new TextEncoder().encode('LIVE E2EE v0.13 ratchet bootstrap')},hk,512);
  const bytes=new Uint8Array(material);
  return {
    deviceId:identity.deviceId,
    sendChainKey:bytes.slice(32,64),
    recvChainKey:bytes.slice(0,32),
  };
}

export async function establishSession(identity, bundle, conversationId) {
  if(!(await verifyDeviceBundle(bundle))) throw new Error('Invalid signed prekey bundle');
  const ephemeral=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
  const peer=await crypto.subtle.importKey('jwk',bundle.signedPrekey,{name:'ECDH',namedCurve:'P-256'},false,[]);
  const bits=await crypto.subtle.deriveBits({name:'ECDH',public:peer},ephemeral.privateKey,256);
  const salt=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`LIVE:session:${conversationId}:${bundle.deviceId}`));
  const hk=await crypto.subtle.importKey('raw',bits,'HKDF',false,['deriveKey']);
  const key=await crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt,info:new TextEncoder().encode('LIVE E2EE v0.11 session')},hk,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
  return {key,ephemeralPublicKey:await crypto.subtle.exportKey('jwk',ephemeral.publicKey),prekeyId:bundle.prekeys?.[0]?.id??null};
}

export async function acceptSession(identity, session, conversationId) {
  const prekeys=await getStoreValue(PREKEYS_ID)||[];
  const record=prekeys.find(p=>p.id===session.prekeyId)||prekeys[0]; if(!record) throw new Error('No local prekey available');
  const privateKey=await crypto.subtle.importKey('jwk',record.privateKey,{name:'ECDH',namedCurve:'P-256'},false,['deriveBits']);
  const peer=await crypto.subtle.importKey('jwk',session.ephemeralPublicKey,{name:'ECDH',namedCurve:'P-256'},false,[]);
  const bits=await crypto.subtle.deriveBits({name:'ECDH',public:peer},privateKey,256);
  const salt=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`LIVE:session:${conversationId}:${identity.deviceId}`));
  const hk=await crypto.subtle.importKey('raw',bits,'HKDF',false,['deriveKey']);
  return crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt,info:new TextEncoder().encode('LIVE E2EE v0.11 session')},hk,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}

const TRANSPARENCY_PREFIX = 'transparency:';
const transparencyCanonical = (entry) => JSON.stringify({accountId:entry.accountId,deviceId:entry.deviceId,fingerprint:entry.fingerprint,action:entry.action,previousHash:entry.previousHash,createdAt:entry.createdAt});
export async function verifyTransparencySnapshot(snapshot) {
  if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.entries) || typeof snapshot.rootHash !== 'string' || typeof snapshot.signature !== 'string' || !snapshot.signingPublicKey) throw new Error('Invalid transparency snapshot');
  let previous='0'.repeat(64);
  for(const entry of snapshot.entries){
    if(entry.previousHash!==previous) throw new Error('Transparency chain break');
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(transparencyCanonical(entry)));
    const hash=Array.from(new Uint8Array(digest)).map(x=>x.toString(16).padStart(2,'0')).join('');
    if(hash!==entry.eventHash) throw new Error('Transparency event hash mismatch');
    previous=hash;
  }
  if(previous!==snapshot.rootHash) throw new Error('Transparency root mismatch');
  const key=await crypto.subtle.importKey('jwk',snapshot.signingPublicKey,{name:'ECDSA',namedCurve:'P-256'},false,['verify']);
  const ok=await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},key,unb64(snapshot.signature),new TextEncoder().encode(snapshot.rootHash));
  if(!ok) throw new Error('Transparency signature invalid');
  return true;
}

export async function inspectTransparencySnapshot(username, snapshot) {
  await verifyTransparencySnapshot(snapshot);
  const key=TRANSPARENCY_PREFIX+String(username).toLowerCase();
  const pinned=await getStoreValue(key);
  if(!pinned){ await putStoreValue(key,{rootHash:snapshot.rootHash,signingPublicKey:snapshot.signingPublicKey,entries:snapshot.entries}); return {status:'pinned',changed:false,rootHash:snapshot.rootHash}; }
  if(JSON.stringify(pinned.signingPublicKey)!==JSON.stringify(snapshot.signingPublicKey)) throw new Error('Transparency signing key changed');
  const priorRoot=pinned.rootHash;
  if(priorRoot===snapshot.rootHash) return {status:'unchanged',changed:false,rootHash:snapshot.rootHash};
  const known=snapshot.entries.some(e=>e.eventHash===priorRoot);
  if(!known) throw new Error('Transparency history fork detected');
  const priorByHash=new Map((pinned.entries||[]).map(e=>[e.eventHash,e]));
  for(const e of snapshot.entries){ if(priorByHash.has(e.eventHash) && JSON.stringify(priorByHash.get(e.eventHash))!==JSON.stringify(e)) throw new Error('Transparency history rewrite detected'); }
  await putStoreValue(key,{rootHash:snapshot.rootHash,signingPublicKey:snapshot.signingPublicKey,entries:snapshot.entries});
  return {status:'advanced',changed:true,rootHash:snapshot.rootHash};
}
