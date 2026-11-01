import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = resolve(repo, 'test/real-producer-integration.mjs');
test('real-producer integration is local and requires an explicit producer checkout', async () => {
  const source = await readFile(script, 'utf8');
  assert.match(source, /const repo = resolve\(dirname\(self\), '\.\.'\)/);
  assert.match(source, /process\.argv\[2\] \?\? process\.env\.PASEO_ACCOUNTS_PRODUCER_REPO/);
  assert.doesNotMatch(source, /\/home\/theo\/\.worktrees\/paseo-accounts\/pi-worker-/);
  assert.doesNotMatch(source, /\.dev\/accounts-review/);
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Pass the producer repository path or set PASEO_ACCOUNTS_PRODUCER_REPO/);
});
