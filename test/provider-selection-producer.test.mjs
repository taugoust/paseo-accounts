#!/usr/bin/env node
// Offline atomicity proof against the fixed producer's ACTUAL service. No live
// descriptors, model requests, producer edits or installs. Account-store writes
// below affect only the producer fixture's temporary in-memory backend.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const self = fileURLToPath(import.meta.url);
const repo = resolve(dirname(self), '..');
if (process.argv[2] !== '--child') {
  const producer = await realpath(process.argv[2] ?? '/home/theo/.worktrees/pi-agent-extensions/pi-worker-90901e07dcb4');
  const root = await mkdtemp(join(tmpdir(), 'selected-provider-proof-'));
  try {
    const runtimePath = join(producer, 'tests/openai-accounts-runtime.mjs');
    const source = await readFile(runtimePath, 'utf8');
    const headerEnd = source.indexOf('test.after('), jwtStart = source.indexOf('function jwtToken(');
    const jwtEnd = source.indexOf('\ntest(', jwtStart), fixtureStart = source.indexOf('async function fixture(');
    const fixtureEnd = source.indexOf('\ntest(', fixtureStart);
    assert.ok(headerEnd > 0 && jwtStart > headerEnd && jwtEnd > jwtStart && fixtureStart > jwtEnd && fixtureEnd > fixtureStart, 'Producer helper layout changed; review extraction');
    let helpers = (source.slice(0, headerEnd) + source.slice(jwtStart, jwtEnd) + source.slice(fixtureStart, fixtureEnd))
      .replace('import test from "node:test";\n', '').replaceAll('import.meta.url', JSON.stringify(pathToFileURL(runtimePath).href));
    for (const name of ['@earendil-works/pi-coding-agent', '@earendil-works/pi-ai']) {
      const packageRoot = join(producer, 'node_modules', name);
      const pkg = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
      helpers = helpers.replaceAll(JSON.stringify(name), JSON.stringify(pathToFileURL(join(packageRoot, pkg.main)).href));
    }
    await writeFile(join(root, 'fixture.mjs'), helpers + '\nexport { fixture, dispose, switchRequest, routingModule };\n');
    const compilerPath = resolve(process.env.PASEO_PLUGIN_COMPILER ?? '/nix/store/p8ighw60sbcns3p4clxxsf5yms7w5fk4-paseo-0.14.0/lib/paseo/packages/server/dist/server/server/plugins/compiler.js');
    const host = resolve(dirname(compilerPath), '../../../../../../');
    const { build } = createRequire(compilerPath)('esbuild');
    await build({ stdin: { contents: 'export {NativePiAccounts} from "./server/pi-native-view";', resolveDir: repo, loader: 'ts' },
      outfile: join(root, 'consumer.mjs'), bundle: true, platform: 'node', format: 'esm',
      plugins: [{ name: 'sdk', setup(b) { b.onResolve({ filter: /^(@getpaseo\/plugin(?:\/shared)?|zod)$/ }, ({ path }) => ({
        path: path === 'zod' ? join(host, 'node_modules/zod/index.js') : join(host, path.endsWith('/shared') ? 'packages/plugin/dist/shared/index.js' : 'packages/plugin/dist/index.js'),
      })); } }],
    });
    const env = { ...process.env, HOME: join(root, 'home'), PI_CODING_AGENT_DIR: join(root, 'agent'), TMPDIR: root };
    for (const key of Object.keys(env)) if (/^(?:PI_SESSION_ROUTING_|OPENAI_|CODEX_)/.test(key)) delete env[key];
    await mkdir(env.HOME, { mode: 0o700 });
    console.log(`Actual producer ${join(producer, 'openai-accounts/accounts.ts')}`);
    console.log(`SHA256 ${createHash('sha256').update(await readFile(join(producer, 'openai-accounts/accounts.ts'))).digest('hex')}`);
    const result = spawnSync(process.execPath, [self, '--child', root], { env, stdio: 'inherit', timeout: 120_000 });
    assert.ifError(result.error); assert.equal(result.status, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
} else {
  const root = process.argv[3]; assert.equal(homedir(), join(root, 'home')); assert.equal(process.env.PI_SESSION_ROUTING_FILE, undefined);
  globalThis.fetch = async () => { throw Error('Network forbidden'); };
  const { fixture, dispose, switchRequest, routingModule } = await import(pathToFileURL(join(root, 'fixture.mjs')));
  const { NativePiAccounts } = await import(pathToFileURL(join(root, 'consumer.mjs')));
  const f = await fixture({ sessionId: `selected-provider-${randomUUID()}` });
  try {
    assert.equal(f.startupError, undefined); assert.equal(f.initial.guardedDefaultSwitchVersion, 1); assert.ok(f.root.startsWith(root + '/'));
    const storeBefore = await f.store.readAsync(); const configuredModelId = f.ctx.model.id;
    const agent = { id: 'selected', provider: 'pi', workspaceId: 'workspace', status: 'idle', archivedAt: null, model: 'openai/stale-alias' };
    const context = { paseo: { agents: { list: () => assert.fail('Host-wide discovery forbidden'), ref: id => { assert.equal(id, 'selected'); return { refresh: async () => ({ agent }) }; } } } };
    const snap = providerId => f.service.getSnapshot({ sessionId: f.sessionId, providerId });
    const pin = async (providerId, name) => { const s = await snap(providerId); const result = await switchRequest(f, name, randomUUID(), s.selectionRevision, providerId, s.sessionRouting.revision); assert.equal(result.ok, true, JSON.stringify(result)); return result.snapshot; };
    const calls = [], results = []; let hook;
    const controls = {
      status: async ({ agentId, workspaceId, providerId }, ctx) => { assert.equal(ctx, context); assert.equal(agentId, agent.id); assert.equal(workspaceId, agent.workspaceId); return { available: true, sessionId: f.sessionId, runtimeEpoch: '11111111-1111-4111-8111-111111111111', snapshot: await snap(providerId), reason: null }; },
      switch: async (input, ctx) => { assert.equal(ctx, context); assert.equal(input.agentId, agent.id); calls.push(structuredClone(input)); if (hook) { const once = hook; hook = undefined; await once(); } const result = await f.service.switchAccount(input.request); results.push(result); return result; },
    };
    const native = new NativePiAccounts(controls); const empty = { reopened: [], deferred: [], failed: [], continuedIn: null };
    const change = (providerId, expectedAccountId) => native.changeProvider(agent.id, providerId, expectedAccountId, context);
    await pin('openai', 'alpha'); const source = await snap('openai');
    assert.deepEqual(await change('openai-codex', 'pi-native:profile:alpha'), { ...empty, reopened: [agent.id] });
    assert.equal(calls.at(-1).request.expectedDefaultSource, undefined); assert.equal(calls.at(-1).request.expectedRoutingRevision, source.sessionRouting.revision);
    assert.equal(calls.at(-1).request.accountId, null); assert.equal((await snap('openai-codex')).defaultSelected, true);
    assert.equal(routingModule.getSessionRoutingProfile(f.ctx).providerId, 'openai-codex'); assert.equal(f.ctx.model.id, configuredModelId);
    console.log('PASS actual producer: selected OpenAI pin replaced by Codex local default; same model role');
    await pin('openai-codex', 'Work');
    assert.deepEqual(await change('openai', 'pi-native:codex:profile:Work'), { ...empty, reopened: [agent.id] });
    assert.equal((await snap('openai')).defaultSelected, true); assert.equal(calls.at(-1).request.expectedDefaultSource, undefined);
    console.log('PASS actual producer: reverse Codex pin -> OpenAI local default');
    await pin('openai', 'alpha');
    assert.deepEqual(await change('openai', 'pi-native:profile:alpha'), { ...empty, reopened: [agent.id] });
    assert.equal((await snap('openai')).defaultSelected, true); assert.equal(calls.at(-1).request.accountId, null);
    assert.equal(calls.at(-1).request.expectedDefaultSource, undefined);
    console.log('PASS actual producer: same-provider selected named pin reset to local default');
    await pin('openai', 'alpha'); hook = async () => { await pin('openai', 'beta'); };
    assert.deepEqual(await change('openai-codex', 'pi-native:profile:alpha'), empty);
    assert.equal(results.at(-1).ok, false); assert.equal(results.at(-1).reason, 'stale-selection');
    assert.equal((await snap('openai')).currentAccountId, 'beta'); assert.equal(routingModule.getSessionRoutingProfile(f.ctx).providerId, 'openai');
    console.log('PASS actual producer: source pin changed after final read; stale route rejected atomically');
    const beforeBusy = await snap('openai'), destinationBefore = await snap('openai-codex');
    const find = f.ctx.modelRegistry.find.bind(f.ctx.modelRegistry); let becameBusy = false;
    hook = async () => { f.ctx.modelRegistry.find = (...args) => { if (args[0] === 'openai-codex') { f.idle = false; becameBusy = true; } return find(...args); }; };
    assert.deepEqual(await change('openai-codex', 'pi-native:profile:beta'), empty); f.ctx.modelRegistry.find = find; f.idle = true;
    assert.equal(becameBusy, true); assert.equal(results.at(-1).reason, 'busy');
    const afterBusy = await snap('openai'), destinationAfter = await snap('openai-codex');
    assert.equal(afterBusy.currentAccountId, beforeBusy.currentAccountId); assert.equal(afterBusy.selectionRevision, beforeBusy.selectionRevision);
    assert.deepEqual(afterBusy.sessionRouting, beforeBusy.sessionRouting); assert.equal(destinationAfter.currentAccountId, destinationBefore.currentAccountId);
    assert.equal(destinationAfter.selectionRevision, destinationBefore.selectionRevision);
    console.log('PASS actual producer: busy during validation -> no selection/revision/route or deferred activation');
    hook = async () => { const d = await snap('openai-codex'); const result = await f.service.manageAccount({ operation: 'rename', sessionId: f.sessionId, providerId: 'openai-codex', accountId: 'Work', label: 'Renamed fixture' }); assert.equal(result.ok, true); assert.equal((await snap('openai-codex')).selectionRevision, d.selectionRevision + 1); };
    assert.deepEqual(await change('openai-codex', 'pi-native:profile:beta'), empty); assert.equal(results.at(-1).reason, 'stale-selection');
    assert.equal(routingModule.getSessionRoutingProfile(f.ctx).accountId, 'beta');
    await f.store.updateProvider('openai-codex', state => ({ ...state, accounts: storeBefore.providers['openai-codex'].accounts }));
    console.log('PASS actual producer: destination selection revision race rejected without changing source routing');
    assert.deepEqual(await f.store.readAsync(), storeBefore); assert.equal(f.delegated.length, 0); assert.equal(f.codexDelegated.length, 0); assert.equal(f.providerErrors.length, 0);
    console.log('PASS isolation: temporary HOME/TMPDIR, offline producer, zero inference or live user mutation');
  } finally { await dispose(f); }
}
