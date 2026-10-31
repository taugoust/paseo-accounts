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
const account = id => ({ id, family: 'pi', status: 'ready', label: id });
const agent = (agentId, extra = {}) => ({ agentId, family: 'pi', provider: 'pi', accountId: 'pi-native:profile:Work', pinned: true, pendingAccountId: null, movable: true, canSwitch: true, status: 'idle', cwd: '/work', ...extra });
const reopened = agentId => ({ reopened: [agentId], deferred: [], failed: [], continuedIn: null });
const source = agent('selected'), busy = agent('busy', { status: 'running' }), other = agent('unselected');
const state = { agents: [source, busy, other], accounts: [account('pi-native:profile:Work'), account('pi-native:profile:Other'), account('pi-native:codex:default')] };
function fixture() {
  const calls = [], refreshes = [];
  const store = { current: { state, error: null }, async refresh() { refreshes.push(1); }, async rpc(rpc, input) { calls.push({ rpc: rpc.name, input }); return reopened(input.agentId); } };
  return { store, calls, refreshes };
}

test('Pi eligibility, canonical provider namespaces and account-target filtering', () => {
  assert.equal(eligible(source, state), true);
  assert.equal(eligible(busy, state), false);
  assert.notEqual(bulkGroup(source, state), bulkGroup(agent('codex', { accountId: 'pi-native:codex:default' }), state));
  assert.deepEqual(compatibleAccounts(source, state).map(row => row.id), ['pi-native:profile:Work', 'pi-native:profile:Other']);
});

test('account and provider operations dispatch only captured selected IDs with fresh no-queue preflights', async () => {
  const f = fixture();
  const accountResult = await bulkChangeAccounts(f.store, [source, busy], 'pi-native:profile:Other', () => true);
  assert.deepEqual([accountResult.changed, accountResult.skipped, accountResult.failed], [1, 1, 0]);
  assert.deepEqual(f.calls.map(row => row.input), [{ agentId: 'selected', accountId: 'pi-native:profile:Other', onlyIfIdle: true }]);
  assert.equal(f.refreshes.length, 2);
  const providerResult = await bulkChangeProvider(f.store, [source], 'openai-codex', () => true);
  assert.deepEqual([providerResult.changed, providerResult.skipped, providerResult.failed], [1, 0, 0]);
  assert.deepEqual(f.calls[1], { rpc: 'paseo-accounts.agents.provider', input: { agentId: 'selected', providerId: 'openai-codex', expectedAccountId: source.accountId } });
});

test('stale sources, non-Pi agents, unsupported pins and invalid fences are skipped', async () => {
  const f = fixture();
  const result = await bulkChangeAccounts(f.store, [source, agent('nonpi', { family: 'claude', provider: 'claude' })], 'pi-native:profile:Other', () => false);
  assert.deepEqual([result.changed, result.skipped, result.failed], [0, 2, 0]);
  assert.deepEqual(f.calls, []);
  assert.equal(bulkGroup(agent('bad', { accountId: 'pi-native:profile:%ZZ' }), state), null);
});
