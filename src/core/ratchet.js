/* LIVE v0.13 experimental ratchet transport layer.
 *
 * This is deliberately NOT presented as a production Signal/Double Ratchet
 * implementation. It provides the state-machine layer LIVE needs next:
 * - independent sending/receiving chains
 * - one-time message-key derivation
 * - skipped-key storage for bounded out-of-order delivery
 * - authenticated headers (AAD)
 * - explicit chain-key rotation
 *
 * A reviewed protocol implementation should replace this before production.
 */
const te = new TextEncoder();
const td = new TextDecoder();
const INFO = te.encode('LIVE E2EE v0.12 ratchet prototype');
const enc = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const dec = (s) => { const p=s.replace(/-/g,'+').replace(/_/g,'/'); const pad='='.repeat((4-p.length%4)%4); return Uint8Array.from(atob(p+pad),c=>c.charCodeAt(0)); };

async function hmacKey(raw) {
  return crypto.subtle.importKey('raw', raw, {name:'HMAC',hash:'SHA-256'}, false, ['sign']);
}
async function hmac(raw, label, counter) {
  const key=await hmacKey(raw);
  const data=new Uint8Array(te.encode(`${label}:`));
  const n=new Uint8Array(4); new DataView(n.buffer).setUint32(0,counter);
  const input=new Uint8Array(data.length+n.length); input.set(data); input.set(n,data.length);
  return new Uint8Array(await crypto.subtle.sign('HMAC',key,input));
}
async function deriveAes(messageKey) {
  const hk=await crypto.subtle.importKey('raw',messageKey,'HKDF',false,['deriveKey']);
  return crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:new Uint8Array(32),info:INFO},hk,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
function assertState(state) {
  if(!state || !state.send || !state.recv) throw new Error('Invalid ratchet state');
  if(!Number.isInteger(state.send.n) || !Number.isInteger(state.recv.n)) throw new Error('Invalid ratchet counters');
}
export function createRatchetState(sendChainKey, recvChainKey, opts={}) {
  if(!(sendChainKey instanceof Uint8Array) || !(recvChainKey instanceof Uint8Array)) throw new Error('Chain keys must be Uint8Array');
  return {v:1, send:{chainKey:enc(sendChainKey),n:opts.sendN||0}, recv:{chainKey:enc(recvChainKey),n:opts.recvN||0}, skipped:{}, maxSkip:Math.min(Math.max(opts.maxSkip||50,1),500)};
}
export function serializeRatchetState(state) { assertState(state); return JSON.parse(JSON.stringify(state)); }
export function deserializeRatchetState(value) { const state=JSON.parse(JSON.stringify(value)); assertState(state); return state; }

async function nextMessageKey(chainKey,n) { return hmac(chainKey,'message',n); }
async function nextChainKey(chainKey,n) { return hmac(chainKey,'chain',n); }
function skipId(n){ return String(n); }

export async function encryptRatchet(state, value, associatedData='') {
  assertState(state);
  const n=state.send.n;
  const chain=dec(state.send.chainKey);
  const messageKey=await nextMessageKey(chain,n);
  const next=await nextChainKey(chain,n);
  state.send={chainKey:enc(next),n:n+1};
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const header={v:1,n,ad:String(associatedData)};
  const aad=te.encode(JSON.stringify(header));
  const aes=await deriveAes(messageKey);
  const plaintext=te.encode(JSON.stringify(value));
  const ct=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad},aes,plaintext);
  return {v:1,header,iv:enc(iv),ct:enc(ct)};
}

async function consumeSkipped(state,n,payload,associatedData) {
  const record=state.skipped[skipId(n)];
  if(!record) return null;
  delete state.skipped[skipId(n)];
  const aes=await deriveAes(dec(record.key));
  const header={v:1,n,ad:String(associatedData)};
  const aad=te.encode(JSON.stringify(header));
  const clear=await crypto.subtle.decrypt({name:'AES-GCM',iv:dec(payload.iv),additionalData:aad},aes,dec(payload.ct));
  return JSON.parse(td.decode(clear));
}

export async function decryptRatchet(state, payload, associatedData='') {
  assertState(state);
  if(!payload?.header || payload.v!==1 || payload.header.v!==1) throw new Error('Unsupported ratchet payload');
  if(String(payload.header.ad)!==String(associatedData)) throw new Error('Associated data mismatch');
  const n=payload.header.n;
  if(!Number.isInteger(n) || n<0) throw new Error('Invalid message number');
  const skipped=await consumeSkipped(state,n,payload,associatedData); if(skipped!==null) return skipped;
  const current=state.recv.n;
  if(n<current) throw new Error('Replay or expired message key');
  if(n-current>state.maxSkip) throw new Error('Too many skipped messages');
  let chain=dec(state.recv.chainKey);
  for(let i=current;i<n;i++) {
    const mk=await nextMessageKey(chain,i);
    state.skipped[skipId(i)]={key:enc(mk)};
    chain=await nextChainKey(chain,i);
  }
  const messageKey=await nextMessageKey(chain,n);
  chain=await nextChainKey(chain,n);
  state.recv={chainKey:enc(chain),n:n+1};
  const aes=await deriveAes(messageKey);
  const header={v:1,n,ad:String(associatedData)};
  const aad=te.encode(JSON.stringify(header));
  const clear=await crypto.subtle.decrypt({name:'AES-GCM',iv:dec(payload.iv),additionalData:aad},aes,dec(payload.ct));
  const value=JSON.parse(td.decode(clear));
  // Keep skipped-key memory bounded even if messages arrive wildly out of order.
  const keys=Object.keys(state.skipped).sort((a,b)=>Number(a)-Number(b));
  while(keys.length>state.maxSkip) delete state.skipped[keys.shift()];
  return value;
}

export async function rotateChain(state, direction='send') {
  assertState(state);
  if(direction!=='send' && direction!=='recv') throw new Error('Invalid ratchet direction');
  const side=state[direction];
  const next=await hmac(dec(side.chainKey),'rotate',side.n);
  state[direction]={chainKey:enc(next),n:side.n};
  return state;
}
