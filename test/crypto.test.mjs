import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

const te = new TextEncoder();
const td = new TextDecoder();

test('E2EE primitive round trip uses ECDH + HKDF + AES-GCM', async () => {
  const a = await webcrypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'}, true, ['deriveBits']);
  const b = await webcrypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'}, true, ['deriveBits']);
  const ap = await webcrypto.subtle.exportKey('jwk', a.publicKey);
  const bp = await webcrypto.subtle.exportKey('jwk', b.publicKey);
  const bPub = await webcrypto.subtle.importKey('jwk', bp, {name:'ECDH',namedCurve:'P-256'}, false, []);
  const aPub = await webcrypto.subtle.importKey('jwk', ap, {name:'ECDH',namedCurve:'P-256'}, false, []);
  const ab = await webcrypto.subtle.deriveBits({name:'ECDH',public:bPub}, a.privateKey, 256);
  const ba = await webcrypto.subtle.deriveBits({name:'ECDH',public:aPub}, b.privateKey, 256);
  assert.deepEqual(Buffer.from(ab), Buffer.from(ba));
  const salt=await webcrypto.subtle.digest('SHA-256',te.encode('LIVE:dm:a:b'));
  const hk=await webcrypto.subtle.importKey('raw',ab,'HKDF',false,['deriveKey']);
  const key=await webcrypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt,info:te.encode('LIVE E2EE v0.9 DM payload')},hk,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
  const iv=webcrypto.getRandomValues(new Uint8Array(12));
  const ct=await webcrypto.subtle.encrypt({name:'AES-GCM',iv},key,te.encode('secret LIVE text'));
  const clear=await webcrypto.subtle.decrypt({name:'AES-GCM',iv},key,ct);
  assert.equal(td.decode(clear),'secret LIVE text');
});

test('v0.11 signed prekey bundle verifies and session derivation agrees', async () => {
  const sign = await webcrypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
  const pre = await webcrypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
  const ep = await webcrypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
  const sp = await webcrypto.subtle.exportKey('jwk', pre.publicKey);
  const sk = await webcrypto.subtle.exportKey('jwk', sign.publicKey);
  const canonical=JSON.stringify({kty:sp.kty,crv:sp.crv,x:sp.x,y:sp.y});
  const sig=await webcrypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},sign.privateKey,te.encode(canonical));
  const ok=await webcrypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},sign.publicKey,sig,te.encode(canonical));
  assert.equal(ok,true);
  const peer=await webcrypto.subtle.importKey('jwk',sp,{name:'ECDH',namedCurve:'P-256'},false,[]);
  const ab=await webcrypto.subtle.deriveBits({name:'ECDH',public:peer},ep.privateKey,256);
  const epPub=await webcrypto.subtle.exportKey('jwk',ep.publicKey);
  const epImported=await webcrypto.subtle.importKey('jwk',epPub,{name:'ECDH',namedCurve:'P-256'},false,[]);
  const ba=await webcrypto.subtle.deriveBits({name:'ECDH',public:epImported},pre.privateKey,256);
  assert.deepEqual(Buffer.from(ab),Buffer.from(ba));
  assert.equal(sk.kty,'EC');
});

test('v0.14 transparency snapshot verifies its hash chain and signature', async()=>{
  const { generateKeyPairSync, sign } = await import('node:crypto');
  const { verifyTransparencySnapshot } = await import('../src/core/crypto.js');
  const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  const pub=pair.publicKey.export({format:'jwk'});
  const entry={accountId:'a',deviceId:'d',fingerprint:'f',action:'registered',previousHash:'0'.repeat(64),createdAt:1};
  const {createHash}=await import('node:crypto');
  const hash=createHash('sha256').update(JSON.stringify(entry)).digest('hex');
  entry.eventHash=hash;
  const signature=sign('sha256',Buffer.from(hash),{key:pair.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64');
  const snap={version:1,accountId:'a',entries:[entry],rootHash:hash,signature,signingPublicKey:pub};
  globalThis.btoa=(s)=>Buffer.from(s,'binary').toString('base64');
  globalThis.atob=(s)=>Buffer.from(s,'base64').toString('binary');
  assert.equal(await verifyTransparencySnapshot(snap),true);
  snap.entries[0].fingerprint='tampered';
  await assert.rejects(()=>verifyTransparencySnapshot(snap),/hash mismatch/);
});
