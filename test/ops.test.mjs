import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryRealtimeBroker } from '../src/realtime-broker.mjs';

test('realtime broker preserves monotonic sequence numbers', async()=>{
  const b=new MemoryRealtimeBroker();
  const a=await b.publish('dm:a:b',{type:'draft.updated',conversationId:'dm:a:b',accountIds:['a','b']});
  const c=await b.publish('dm:a:b',{type:'draft.updated',conversationId:'dm:a:b',accountIds:['a','b']});
  assert.equal(c.seq,a.seq+1);
});

test('replay authorization never returns an unrelated account event', async()=>{
  const b=new MemoryRealtimeBroker();
  await b.publish('dm:a:b',{type:'draft.updated',conversationId:'dm:a:b',accountIds:['a','b']});
  await b.publish('dm:x:y',{type:'draft.updated',conversationId:'dm:x:y',accountIds:['x','y']});
  assert.equal((await b.replay(0,'z',new Set())).length,0);
  assert.equal((await b.replay(0,'b',new Set(['dm:a:b']))).length,1);
});

test('v0.14 key transparency migration is present', async()=>{
  const { readFileSync } = await import('node:fs');
  const sql=readFileSync(new URL('../migrations/007_key_transparency.sql',import.meta.url),'utf8');
  assert.match(sql,/live_key_transparency/);
  assert.match(sql,/event_hash/);
});
