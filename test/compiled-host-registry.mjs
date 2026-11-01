import assert from 'node:assert/strict';
import test from 'node:test';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
const compilerPath = process.env.PASEO_PLUGIN_COMPILER ?? '/nix/store/p8ighw60sbcns3p4clxxsf5yms7w5fk4-paseo-0.14.0/lib/paseo/packages/server/dist/server/server/plugins/compiler.js';
const { compilePlugin } = await import(pathToFileURL(compilerPath));
test('separately compiled host registries isolate stores and fence disconnect/replacement', async () => {
  const dirs = [];
  async function compile() {
    const root = await mkdtemp(join(tmpdir(), 'accounts-registry-')); dirs.push(root);
    await cp(new URL('../client', import.meta.url), join(root, 'client'), { recursive: true });
    await writeFile(join(root, 'index.client.tsx'), "export { createHostBinding, hostLease, hostLeaseCurrent, usableHost, withHost } from './client/host-registry';\n");
    const { clientBundle } = await compilePlugin({ client: join(root, 'index.client.tsx') });
    return (0, eval)(clientBundle)(name => { throw Error(`unexpected runtime import: ${name}`); });
  }
  try {
    const a = await compile(), b = await compile();
    const store = (host) => ({ host, async refresh() { return host; } });
    const one = a.createHostBinding(store('one')), two = b.createHostBinding(store('two'));
    one.bind('registry-one', true); two.bind('registry-two', true);
    const sourceLease = a.hostLease('registry-one'), oldTargetLease = a.hostLease('registry-two');
    assert.equal(a.hostLeaseCurrent('registry-one', sourceLease), true);
    assert.equal(await a.withHost('registry-one', async s => s.host), 'one');
    assert.equal(await a.withHost('registry-two', async s => s.host), 'two');
    let release; const gate = new Promise(resolve => { release = resolve; });
    const pending = a.withHost('registry-two', async (_s, current) => { await gate; current(); return 'dispatched'; });
    two.bind('registry-two', false); release(); await assert.rejects(pending, /unavailable/);
    const replacement = b.createHostBinding(store('replacement')); replacement.bind('registry-two', true);
    assert.equal(a.hostLeaseCurrent('registry-two', oldTargetLease), false);
    two.bind('registry-two', true); two.dispose();
    assert.equal(await a.withHost('registry-two', async s => s.host), 'replacement');
    replacement.dispose(); one.dispose();
    assert.equal(a.usableHost('registry-two'), false);
  } finally { await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true }))); }
});
