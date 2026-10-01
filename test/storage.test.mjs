import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepository } from '../src/storage/repository.mjs';

test('JSON compatibility repository round-trips all LIVE state', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'live-repo-'));
  try {
    const repo = await createRepository({ dataDir: dir });
    const state = {
      accounts: [{ id: 'u-test', username: 'test' }],
      requests: [{ id: 'r-test', status: 'accepted' }],
      conversations: { 'dm:u-test:u-two': [{ id: 'm-test', text: 'hello' }] },
      convMeta: { 'dm:u-test:u-two': { lastAt: 123 } },
      sessions: { token: { accountId: 'u-test', expiresAt: 456 } },
      blocks: [],
      reports: [],
    };
    await repo.save(state);
    const loaded = await repo.load();
    assert.deepEqual(loaded, state);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'accounts.json'))), state.accounts);
    await repo.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
