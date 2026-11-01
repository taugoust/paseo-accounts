#!/usr/bin/env node
// Run: node test/real-producer-integration.mjs /path/to/pi-agent-extensions
// Imports the selected producer's real accounts.ts; no producer edits, installs, live descriptors, login, network, or inference.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { esbuild, paseoResolverPlugin } from './support/nix-deps.mjs';
const self = fileURLToPath(import.meta.url);
const repo = resolve(dirname(self), '..');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

if (process.argv[2] !== '--fixture-child') {
  const producerArg = process.argv[2] ?? process.env.PASEO_ACCOUNTS_PRODUCER_REPO;
  assert.ok(producerArg, 'Pass the producer repository path or set PASEO_ACCOUNTS_PRODUCER_REPO.');
  const producer = await realpath(resolve(producerArg));
  const root = await mkdtemp(join(tmpdir(), 'accounts-producer-integration-'));
  try {
    // Reuse only helper declarations and the fake-session fixture from the selected producer's
    // runtime test module. Registered producer tests (some invoke inference) are deliberately omitted.
    // Imports resolve back to the producer checkout, so runtime implementation remains real.
    const runtimePath = join(producer, 'tests/openai-accounts-runtime.mjs');
    const source = await readFile(runtimePath, 'utf8');
    const headerEnd = source.indexOf('test.after(');
    const jwtStart = source.indexOf('function jwtToken(');
    const jwtEnd = source.indexOf('\ntest(', jwtStart);
    const fixtureStart = source.indexOf('async function fixture(');
    const fixtureEnd = source.indexOf('\ntest(', fixtureStart);
    assert.ok(headerEnd > 0 && jwtStart > headerEnd && jwtEnd > jwtStart && fixtureStart > jwtEnd && fixtureEnd > fixtureStart,
      'Producer runtime helper layout changed; review fixture extraction rather than substituting synthetic producer behavior');
    let helpers = source.slice(0, headerEnd) + source.slice(jwtStart, jwtEnd) + source.slice(fixtureStart, fixtureEnd);
    helpers = helpers.replace('import test from "node:test";\n', '')
      .replaceAll('import.meta.url', JSON.stringify(pathToFileURL(runtimePath).href));
    for (const name of ['@earendil-works/pi-coding-agent', '@earendil-works/pi-ai']) {
      const packageRoot = join(producer, 'node_modules', name);
      const pkg = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
      const entry = pathToFileURL(join(packageRoot, pkg.main)).href;
      helpers = helpers.replaceAll(JSON.stringify(name), JSON.stringify(entry));
    }
    await writeFile(join(root, 'producer-fixture.mjs'), helpers + '\nexport { fixture, dispose, switchRequest, routingModule };\n');
    const { build } = esbuild;
    await build({
      stdin: { contents: `export {applyPiProvider} from ${JSON.stringify(join(repo, 'server/pi-provider.ts'))}; export {createAccountControlsHandlers} from ${JSON.stringify(join(repo, 'server/pi-native.ts'))}; export {NativePiAccounts} from ${JSON.stringify(join(repo, 'server/pi-native-view.ts'))};`, resolveDir: repo, loader: 'ts' },
      outfile: join(root, 'consumer.mjs'), bundle: true, platform: 'node', format: 'esm', plugins: [paseoResolverPlugin()],
    });
    const env = { ...process.env, HOME: join(root, 'home'), PI_CODING_AGENT_DIR: join(root, 'agent'), TMPDIR: root };
    for (const key of Object.keys(env)) if (/^(?:PI_SESSION_ROUTING_|OPENAI_|CODEX_)/.test(key)) delete env[key];
    await mkdir(env.HOME, { mode: 0o700 });
    console.log(`Consumer source: ${repo}`);
    console.log(`REAL producer import: ${join(producer, 'openai-accounts/accounts.ts')}`);
    console.log(`Producer accounts.ts sha256: ${sha256(await readFile(join(producer, 'openai-accounts/accounts.ts')))}`);
    console.log(`Producer runtime fixture sha256: ${sha256(source)}`);
    const child = spawnSync(process.execPath, [self, '--fixture-child', root], { env, stdio: 'inherit', timeout: 120_000 });
    assert.ifError(child.error);
    assert.equal(child.status, 0, `Fixture subprocess failed (signal ${child.signal})`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
} else {
  const root = process.argv[3];
  assert.equal(homedir(), join(root, 'home'), 'Never inspect live HOME descriptors');
  assert.equal(process.env.PI_SESSION_ROUTING_FILE, undefined);
  assert.equal(process.env.PI_SESSION_ROUTING_OWNER_SESSION, undefined);
  globalThis.fetch = async () => { throw new Error('Network fetch forbidden in Accounts integration fixture'); };
  const { fixture, dispose, switchRequest, routingModule } = await import(pathToFileURL(join(root, 'producer-fixture.mjs')));
  const { applyPiProvider, createAccountControlsHandlers, NativePiAccounts } = await import(pathToFileURL(join(root, 'consumer.mjs')));
  const f = await fixture({ sessionId: `accounts-fixture-${randomUUID()}` });
  let server;
  const sockets = new Set();
  try {
    assert.equal(f.startupError, undefined);
    assert.equal(f.service, globalThis.__paeAccountControlsV1, 'Use the service registered by actual producer extension');
    assert.equal(f.initial.guardedDefaultSwitchVersion, 1, 'Requires fixed producer capability');
    assert.ok(f.root.startsWith(root + '/'), 'Producer state must also be inside isolated TMPDIR');
    assert.equal(f.ctx.isIdle(), true);
    const originalStore = await f.store.readAsync();
    const agent = { id: `fixture-agent-${randomUUID()}`, provider: 'pi', workspaceId: 'fixture-workspace', status: 'idle', archivedAt: null, model: 'openai/fixture-alias' };
    const descriptor = { version: 1, socketPath: join(root, 'controls.sock'), capability: randomBytes(32).toString('hex'),
      agentId: agent.id, sessionId: f.sessionId, runtimeEpoch: randomUUID(), serviceEpoch: f.service.serviceEpoch };
    const switches = [];
    const results = [];
    let legacy = false;
    let beforeSwitch;
    // Only socket framing is a fixture. Every snapshot and switch result comes from the imported producer.
    server = createServer((socket) => {
      sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}); socket.setEncoding('utf8');
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk;
        if (buffer.length > 32 * 1024) return socket.destroy();
        if (!buffer.includes('\n')) return;
        socket.removeAllListeners('data');
        void (async () => {
          const frame = JSON.parse(buffer.trim());
          assert.equal(frame.v, 1); assert.equal(frame.type, 'account_controls');
          for (const key of ['capability', 'agentId', 'sessionId', 'runtimeEpoch', 'serviceEpoch']) assert.equal(frame[key], descriptor[key]);
          const request = frame.request;
          let data;
          if (request.operation === 'snapshot') {
            data = await f.service.getSnapshot(request);
            if (legacy) { data = structuredClone(data); delete data.guardedDefaultSwitchVersion; }
          } else {
            assert.equal(request.operation, 'switch', 'No account-management operation allowed');
            switches.push(structuredClone(request.request));
            if (beforeSwitch) { const hook = beforeSwitch; beforeSwitch = undefined; await hook(); }
            data = await f.service.switchAccount(request.request);
            results.push(data);
          }
          socket.end(JSON.stringify({ v: 1, type: 'account_controls', id: frame.id, success: true,
            agentId: descriptor.agentId, sessionId: descriptor.sessionId, runtimeEpoch: descriptor.runtimeEpoch, serviceEpoch: descriptor.serviceEpoch, data }) + '\n');
        })().catch((error) => socket.destroy(error));
      });
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(descriptor.socketPath, resolve); });
    await chmod(descriptor.socketPath, 0o600);
    const descriptors = join(homedir(), '.pi/paseo-bridge/operators');
    await mkdir(descriptors, { recursive: true, mode: 0o700 });
    await writeFile(join(descriptors, `${sha256(agent.id)}.accounts.json`), JSON.stringify(descriptor), { mode: 0o600 });
    const context = { paseo: { agents: {
      list: async () => ({ entries: [{ agent }], pageInfo: { hasMore: false } }),
      ref: (id) => { assert.equal(id, agent.id); return { refresh: async () => ({ agent }) }; },
    } } };
    const controls = createAccountControlsHandlers();
    const apply = (providerId, apply = true) => applyPiProvider({ providerId, apply }, context, controls);
    const snap = (providerId) => f.service.getSnapshot({ sessionId: f.sessionId, providerId });
    const pin = async (accountId) => {
      const s = await snap('openai-codex');
      const changed = await switchRequest(f, accountId, randomUUID(), s.selectionRevision, 'openai-codex', s.sessionRouting.revision);
      assert.equal(changed.ok, true, JSON.stringify(changed)); return changed.snapshot;
    };
    const dry = await apply('openai-codex', false);
    assert.equal(dry.eligibleCount, 1); assert.deepEqual(dry.failed, []); assert.equal(switches.length, 0);
    const source = await snap('openai');
    const positive = await apply('openai-codex');
    assert.deepEqual(positive.applied, [agent.id], JSON.stringify(positive));
    assert.deepEqual(positive.failed, []); assert.equal(switches.length, 1); assert.equal(results[0].ok, true);
    assert.deepEqual(switches[0].expectedDefaultSource, { providerId: 'openai', selectionRevision: source.selectionRevision });
    assert.equal(switches[0].accountId, null); assert.equal(switches[0].expectedRoutingRevision, source.sessionRouting.revision);
    assert.equal(Object.hasOwn(switches[0], 'expectedDefaultSelection'), false, 'Never send obsolete guard field');
    assert.equal(routingModule.getSessionRoutingProfile(f.ctx).providerId, 'openai-codex');
    assert.equal((await snap('openai-codex')).defaultSelected, true);
    console.log('PASS real consumer transport -> real producer: default provider switch committed');

    await pin('Work');
    const pinnedBefore = await snap('openai-codex');
    const pinnedRoute = structuredClone(routingModule.getSessionRoutingProfile(f.ctx));
    const pinned = await apply('openai');
    assert.equal(pinned.pinnedCount, 1); assert.deepEqual(pinned.applied, []); assert.deepEqual(pinned.failed, []);
    assert.equal(switches.length, 1, 'Consumer must not dispatch a switch for explicit pins');
    assert.deepEqual(await snap('openai-codex'), pinnedBefore); assert.deepEqual(routingModule.getSessionRoutingProfile(f.ctx), pinnedRoute);
    console.log('PASS explicit pin: consumer skips it and producer routing/account stay unchanged');

    await pin(null);
    beforeSwitch = async () => { await pin('Work'); };
    const raced = await apply('openai');
    assert.deepEqual(raced.applied, []); assert.equal(raced.skipped.length, 1);
    assert.equal(switches.length, 2); assert.equal(results[1].ok, false); assert.equal(results[1].reason, 'stale-selection');
    assert.equal((await snap('openai-codex')).currentAccountId, 'Work');
    assert.equal(routingModule.getSessionRoutingProfile(f.ctx).providerId, 'openai-codex');
    assert.equal(routingModule.getSessionRoutingProfile(f.ctx).accountId, 'Work');
    console.log('PASS atomic race: REAL producer rejects guarded switch when a pin appears after consumer preflight');

    await pin(null);
    const legacyBefore = await snap('openai-codex'); legacy = true;
    const old = await apply('openai');
    assert.equal(old.eligibleCount, 0); assert.deepEqual(old.applied, []); assert.equal(old.skipped.length, 1);
    assert.equal(switches.length, 2, 'Legacy capability must fail closed before sending any switch');
    assert.deepEqual(await snap('openai-codex'), legacyBefore);
    console.log('PASS legacy producer capability absent: consumer fails closed without dispatch');

    legacy = false;
    const native = new NativePiAccounts(controls);
    await pin('Work');
    const explicit = await native.switch(agent.id, 'pi-native:codex:default', context, true);
    assert.deepEqual(explicit.reopened, [agent.id]); assert.equal((await snap('openai-codex')).defaultSelected, true);
    console.log('PASS same-host guarded account switch: explicitly selected pin overridden in its own namespace');

    const beforeBusy = await snap('openai-codex');
    const readProvider = f.store.readProviderAsync.bind(f.store);
    let enteredBusy, releaseBusy;
    const busyEntered = new Promise(resolve => { enteredBusy = resolve; });
    const busyGate = new Promise(resolve => { releaseBusy = resolve; });
    beforeSwitch = async () => {
      let first = true;
      f.store.readProviderAsync = async (...args) => { if (first) { first = false; enteredBusy(); await busyGate; } return readProvider(...args); };
    };
    const busyRequest = native.switch(agent.id, 'pi-native:codex:profile:Work', context, true);
    await busyEntered; f.idle = false; releaseBusy();
    const busyRace = await busyRequest;
    f.store.readProviderAsync = readProvider; f.idle = true;
    assert.deepEqual(busyRace, { reopened: [], deferred: [], failed: [], continuedIn: null });
    const afterBusy = await snap('openai-codex');
    assert.equal(afterBusy.currentAccountId, beforeBusy.currentAccountId); assert.equal(afterBusy.selectionRevision, beforeBusy.selectionRevision);
    assert.deepEqual(afterBusy.sessionRouting, beforeBusy.sessionRouting);
    assert.equal(results.at(-1).ok, false); assert.equal(results.at(-1).reason, 'busy');
    console.log('PASS same-host busy transition during real producer awaited account read: rejected; zero changed selection, route or queued binding');

    const dispatchesBeforeMismatch = switches.length;
    const mismatch = await native.switch(agent.id, 'pi-native:default', context, true);
    assert.deepEqual(mismatch, { reopened: [], deferred: [], failed: [], continuedIn: null });
    assert.equal(switches.length, dispatchesBeforeMismatch, 'Guarded account changes never cross the current namespace');
    console.log('PASS same-host guarded provider mismatch: skipped before mutation');

    await pin('Work');
    const modelIdBeforeProvider = f.ctx.model.id;
    const selectedProvider = await native.changeProvider(agent.id, 'openai', 'pi-native:codex:profile:Work', context);
    assert.deepEqual(selectedProvider.reopened, [agent.id], JSON.stringify(selectedProvider));
    assert.equal((await snap('openai')).defaultSelected, true); assert.equal(routingModule.getSessionRoutingProfile(f.ctx).providerId, 'openai');
    assert.equal(f.ctx.model.provider, 'openai'); assert.equal(f.ctx.model.id, modelIdBeforeProvider);
    console.log('PASS selected-session provider: real pinned Codex source replaced by OpenAI host-local default, mapped model ID retained');

    const openaiBeforePin = await snap('openai');
    const selectedPin = await switchRequest(f, 'alpha', randomUUID(), openaiBeforePin.selectionRevision, 'openai', openaiBeforePin.sessionRouting.revision);
    assert.equal(selectedPin.ok, true);
    const sameProviderReset = await native.changeProvider(agent.id, 'openai', 'pi-native:profile:alpha', context);
    assert.deepEqual(sameProviderReset.reopened, [agent.id]); assert.equal((await snap('openai')).defaultSelected, true);
    console.log('PASS selected already-current provider: explicit account pin reset to its local default');

    const providerSourceBefore = await snap('openai'), providerTargetBefore = await snap('openai-codex');
    const providerRouteBefore = structuredClone(routingModule.getSessionRoutingProfile(f.ctx));
    const originalFind = f.registry.find.bind(f.registry);
    let modelValidationObserved = false;
    beforeSwitch = async () => {
      f.registry.find = (...args) => {
        const model = originalFind(...args);
        if (!modelValidationObserved && args[0] === 'openai-codex') { modelValidationObserved = true; queueMicrotask(() => { f.idle = false; }); }
        return model;
      };
    };
    const providerBusy = await native.changeProvider(agent.id, 'openai-codex', 'pi-native:default', context);
    f.registry.find = originalFind; f.idle = true;
    assert.equal(modelValidationObserved, true, 'Race must reach real producer model validation');
    assert.deepEqual(providerBusy, { reopened: [], deferred: [], failed: [], continuedIn: null });
    assert.equal((await snap('openai')).selectionRevision, providerSourceBefore.selectionRevision);
    assert.equal((await snap('openai-codex')).selectionRevision, providerTargetBefore.selectionRevision);
    assert.deepEqual(routingModule.getSessionRoutingProfile(f.ctx), providerRouteBefore);
    console.log('PASS selected provider busy after real model-validation yield: skipped, source/destination revisions and route unchanged');

    beforeSwitch = async () => { f.registry.find = (...args) => args[0] === 'openai-codex' ? undefined : originalFind(...args); };
    const noMappedModel = await native.changeProvider(agent.id, 'openai-codex', 'pi-native:default', context);
    f.registry.find = originalFind;
    assert.equal(noMappedModel.failed.length, 1);
    assert.equal((await snap('openai')).selectionRevision, providerSourceBefore.selectionRevision);
    assert.equal((await snap('openai-codex')).selectionRevision, providerTargetBefore.selectionRevision);
    assert.equal(routingModule.getSessionRoutingProfile(f.ctx).providerId, 'openai');
    console.log('PASS destination model mapping absent: fails without choosing another model or changing selections');

    assert.deepEqual(await f.store.readAsync(), originalStore, 'Session switches must never mutate global account defaults/credentials');
    assert.equal(f.delegated.length, 0); assert.equal(f.codexDelegated.length, 0); assert.equal(f.providerErrors.length, 0);
    assert.ok(f.entries.length > 0, 'Changes persisted only to fake session manager entries');
    console.log('PASS isolation: temporary HOME/TMPDIR/auth/routing, in-memory account store, fake idle session, zero inference, zero live account/session mutation');
  } finally {
    for (const socket of sockets) socket.destroy();
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    await dispose(f);
  }
}
