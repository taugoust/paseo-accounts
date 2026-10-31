// Materialize browser-only runtime dependencies from an immutable Nix npm cache.
// No registry, package manager, lifecycle scripts, or global/local project install.
import { readFile, mkdir, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
export const reviewDir = dirname(fileURLToPath(import.meta.url));
export const repo = resolve(reviewDir, '../..');
export const host = process.env.PASEO_NIX_ROOT ?? '/nix/store/p8ighw60sbcns3p4clxxsf5yms7w5fk4-paseo-0.14.0/lib/paseo';
export const compilerPath = process.env.PASEO_PLUGIN_COMPILER ?? join(host, 'packages/server/dist/server/server/plugins/compiler.js');
export const cache = process.env.PASEO_NPM_CACHE ?? '/nix/store/kg96l1i0v09r52dsydn2sfrhyxjyrjn7-paseo-0.14.0-npm-deps';
export const depsDir = join(reviewDir, 'nix-deps');
export async function browserDeps() {
  const lock = JSON.parse(await readFile(join(cache, 'package-lock.json'), 'utf8'));
  const done = new Set();
  function locate(name, importer = '') {
    let location = importer;
    for (;;) {
      const candidate = `${location ? location + '/' : ''}node_modules/${name}`;
      if (lock.packages[candidate]) return candidate;
      if (!location) throw Error(`Nix lock has no ${name} imported by ${importer}`);
      location = location.replace(/(?:^|\/)node_modules\/(\@[^/]+\/)?[^/]+$/, '');
    }
  }
  async function extract(key) {
    if (done.has(key)) return;
    done.add(key);
    const entry = lock.packages[key];
    const target = join(depsDir, key);
    try { await access(join(target, 'package.json')); }
    catch {
      const [algorithm, encoded] = entry.integrity.split('-');
      const digest = Buffer.from(encoded, 'base64').toString('hex');
      const archive = join(cache, '_cacache/content-v2', algorithm, digest.slice(0, 2), digest.slice(2, 4), digest.slice(4));
      const content = await readFile(archive);
      if (createHash(algorithm).update(content).digest('hex') !== digest) throw Error(`Integrity mismatch: ${key}`);
      await mkdir(target, { recursive: true });
      execFileSync('tar', ['-xzf', archive, '--strip-components=1', '-C', target]);
    }
    for (const name of Object.keys(entry.dependencies ?? {})) await extract(locate(name, key));
  }
  for (const name of ['react', 'react-dom', 'react-native-web', 'lucide-react']) await extract(locate(name));
  return [...done].map(key => ({ path: key, version: lock.packages[key].version, integrity: lock.packages[key].integrity }));
}
