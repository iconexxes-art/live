import test from 'node:test';
import assert from 'node:assert/strict';
import { createRatchetState, encryptRatchet, decryptRatchet, serializeRatchetState, deserializeRatchetState, rotateChain } from '../src/core/ratchet.js';

globalThis.btoa = (s)=>Buffer.from(s,'binary').toString('base64');
globalThis.atob = (s)=>Buffer.from(s,'base64').toString('binary');

const k=(n)=>new Uint8Array(Array.from({length:32},(_,i)=>(i+n)&255));

function pair(){ return [createRatchetState(k(1),k(2)), createRatchetState(k(2),k(1))]; }

test('v0.12 ratchet encrypt/decrypt advances one-time message keys', async()=>{
  const [a,b]=pair();
  const p1=await encryptRatchet(a,{text:'one'},'c1');
  const p2=await encryptRatchet(a,{text:'two'},'c1');
  assert.deepEqual(await decryptRatchet(b,p1,'c1'),{text:'one'});
  assert.deepEqual(await decryptRatchet(b,p2,'c1'),{text:'two'});
  assert.equal(a.send.n,2); assert.equal(b.recv.n,2);
  await assert.rejects(()=>decryptRatchet(b,p1,'c1'), /Replay|expired/);
});

test('v0.12 handles bounded out-of-order delivery with skipped keys', async()=>{
  const [a,b]=pair();
  const p=[];
  for(let i=0;i<4;i++) p.push(await encryptRatchet(a,{n:i},'c2'));
  assert.deepEqual(await decryptRatchet(b,p[3],'c2'),{n:3});
  assert.deepEqual(await decryptRatchet(b,p[1],'c2'),{n:1});
  assert.deepEqual(await decryptRatchet(b,p[0],'c2'),{n:0});
  assert.deepEqual(await decryptRatchet(b,p[2],'c2'),{n:2});
  assert.equal(Object.keys(b.skipped).length,0);
});

test('v0.12 rejects excessive gaps and associated-data tampering', async()=>{
  const [a,b]=pair(); b.maxSkip=2;
  const p=[];
  for(let i=0;i<4;i++) p.push(await encryptRatchet(a,{n:i},'c3'));
  await assert.rejects(()=>decryptRatchet(b,p[3],'c3'), /Too many skipped/);
  await assert.rejects(()=>decryptRatchet(b,p[0],'WRONG'), /Associated data mismatch/);
});

test('v0.12 state survives serialization and chain rotation is explicit', async()=>{
  const [a,b]=pair();
  const p=await encryptRatchet(a,{ok:true},'c4');
  const saved=serializeRatchetState(b);
  const restored=deserializeRatchetState(saved);
  assert.deepEqual(await decryptRatchet(restored,p,'c4'),{ok:true});
  const before=restored.send.chainKey;
  await rotateChain(restored,'send');
  assert.notEqual(restored.send.chainKey,before);
  assert.equal(restored.send.n,0);
});
