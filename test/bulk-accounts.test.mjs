import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const compilerPath = process.env.PASEO_PLUGIN_COMPILER;
assert.ok(compilerPath, 'PASEO_PLUGIN_COMPILER must identify the installed host compiler');
const require = createRequire(resolve(compilerPath));
const { compilePlugin } = await import(pathToFileURL(resolve(compilerPath)));
const root = await mkdtemp(join(tmpdir(), 'accounts-bulk-'));
let helper;
try {
  for (const directory of ['client', 'shared']) await cp(new URL(`../${directory}`, import.meta.url), join(root, directory), { recursive: true });
  await writeFile(join(root, 'index.client.tsx'), "export * from './client/bulk-accounts';\n");
  const { clientBundle } = await compilePlugin({ client: join(root, 'index.client.tsx') });
  helper = (0, eval)(clientBundle)(name => name === '@getpaseo/plugin' ? { defineRpc: contract => contract } : require(name));
} finally { await rm(root, { recursive: true, force: true }); }
const { bulkGroup, eligible, compatibleAccounts, bulkChangeAccounts, bulkChangeProvider } = helper;
const WORK = 'pi-native:codex:profile:Work', OTHER = 'pi-native:codex:profile:Other';
const account = id => ({ id, family: 'pi', status: 'ready', label: id });
const agent = (agentId, extra = {}) => ({
  agentId, family: 'pi', provider: 'pi', accountId: WORK, pinned: true, pendingAccountId: null,
  movable: true, canSwitch: true, status: 'idle', cwd: '/work', ...extra,
});
const reopened = agentId => ({ reopened: [agentId], deferred: [], failed: [], continuedIn: null });
const source = agent('selected'), busy = agent('busy', { status: 'running' }), other = agent('unselected');
const CODEX_DEFAULT = 'pi-native:codex:default', LEGACY = 'pi-native:profile:Legacy';
const state = {
  agents: [source, busy, other],
  accounts: [account(WORK), account(OTHER), account(CODEX_DEFAULT), account(LEGACY)],
};
function fixture() {
  const calls = [], refreshes = [];
  const store = { current: { state, error: null }, async refresh() { refreshes.push(1); }, async rpc(rpc, input) { calls.push({ rpc: rpc.name, input }); return reopened(input.agentId); } };
  return { store, calls, refreshes };
}

test('Pi eligibility, Codex-only accounts and account-target filtering', () => {
  assert.equal(eligible(source, state), true);
  assert.equal(eligible(busy, state), false);
  const onDefault = agent('codex', { accountId: CODEX_DEFAULT });
  assert.equal(bulkGroup(source, state), bulkGroup(onDefault, state));
  assert.equal(bulkGroup(agent('legacy', { accountId: LEGACY }), state), null);
  const targets = compatibleAccounts(source, state).map(row => row.id);
  assert.deepEqual(targets, [WORK, OTHER, CODEX_DEFAULT]);
  assert.equal(bulkChangeProvider, undefined, 'provider changes are gone');
});

test('account changes dispatch only captured selected IDs with fresh preflights', async () => {
  const f = fixture();
  const accountResult = await bulkChangeAccounts(f.store, [source, busy], OTHER, () => true);
  assert.deepEqual([accountResult.changed, accountResult.skipped, accountResult.failed], [1, 1, 0]);
  assert.deepEqual(f.calls, [{
    rpc: 'paseo-accounts.agents.account',
    input: { agentId: 'selected', accountId: OTHER, onlyIfIdle: true },
  }]);
  assert.equal(f.refreshes.length, 2);
});

test('stale sources, non-Pi agents, unsupported pins and invalid fences are skipped', async () => {
  const f = fixture();
  const nonPi = agent('nonpi', { family: 'claude', provider: 'claude' });
  const result = await bulkChangeAccounts(f.store, [source, nonPi], OTHER, () => false);
  assert.deepEqual([result.changed, result.skipped, result.failed], [0, 2, 0]);
  assert.deepEqual(f.calls, []);
  assert.equal(bulkGroup(agent('bad', { accountId: 'pi-native:codex:profile:%ZZ' }), state), null);
});
