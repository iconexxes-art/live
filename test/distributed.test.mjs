import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryRealtimeBroker } from '../src/realtime-broker.mjs';

test('distributed broker contract preserves ordering, publication and replay authorization', async () => {
  const broker = new MemoryRealtimeBroker();
  const received = [];
  broker.onEvent(e => received.push(e));
  const a = await broker.publish('dm:a:b', { type:'draft.updated', conversationId:'dm:a:b', accountIds:['a','b'] });
  const b = await broker.publish('dm:a:b', { type:'draft.updated', conversationId:'dm:a:b', accountIds:['a','b'] });
  const c = await broker.publish('dm:x:y', { type:'draft.updated', conversationId:'dm:x:y', accountIds:['x','y'] });
  await new Promise(r => setImmediate(r));
  assert.deepEqual(received.map(x=>x.seq), [1,2,3]);
  assert.equal(a.seq,1); assert.equal(b.seq,2); assert.equal(c.seq,3);
  const replay = await broker.replay(1, 'b', new Set(['dm:a:b']));
  assert.deepEqual(replay.map(x=>x.seq), [2]);
  const denied = await broker.replay(0, 'z', new Set());
  assert.deepEqual(denied, []);
});
