import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { browserDeps, compilerPath, depsDir, host, repo, reviewDir } from './nix-deps.mjs';

export const out = join(reviewDir, 'artifacts/bulk');
export async function startBulkHarness() {
  await mkdir(out, { recursive: true });
  const dependencies = await browserDeps();
  const { compilePlugin } = await import(pathToFileURL(compilerPath));
  const snapshot = await mkdtemp(join(reviewDir, 'bulk-source-'));
  let clientBundle;
  try {
    for (const dir of ['client', 'shared']) await cp(join(repo, dir), join(snapshot, dir), { recursive: true });
    await writeFile(join(snapshot, 'index.client.tsx'), "export { AccountsSurface } from './client/accounts-surface';\nexport { AgentsTab } from './client/agents-tab';\nimport { StateViewSchema } from './shared/model';\nexport function parseState(input: unknown) { return StateViewSchema.parse(input); }\n");
    ({ clientBundle } = await compilePlugin({ client: join(snapshot, 'index.client.tsx') }));
    await writeFile(join(out, 'factory.js'), `export default ${clientBundle};\n`);
  } finally { await rm(snapshot, { recursive: true, force: true }); }
  const { build } = createRequire(compilerPath)('esbuild');
  const built = await build({ entryPoints: [join(reviewDir, 'bulk-fixture.tsx')], bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic', write: false,
    alias: { 'react-native': join(depsDir, 'node_modules/react-native-web'), react: join(depsDir, 'node_modules/react'), 'react-dom': join(depsDir, 'node_modules/react-dom'), zod: join(host, 'node_modules/zod') },
    nodePaths: [join(depsDir, 'node_modules')], define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
  const browserJS = built.outputFiles[0].text;
  await writeFile(join(out, 'browser.js'), browserJS);
  const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Synthetic bulk Agents fixture</title><style>html,body,#root{height:100%;margin:0;background:#0e0e10}#root{display:flex;flex-direction:column}*{box-sizing:border-box}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>';
  const server = createServer((request, response) => {
    if (request.url === '/fixture.js') { response.setHeader('content-type', 'application/javascript'); response.end(browserJS); }
    else if (request.url === '/' || request.url === '/favicon.ico') { response.setHeader('content-type', 'text/html'); response.end(html); }
    else { response.statusCode = 404; response.end(); }
  });
  let browser;
  let closed = false;
  const closeServer = async () => {
    if (!server.listening) return;
    const stopped = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await stopped;
  };
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_CORE ?? '/nix/store/19n2k7i89gvprmjriygiid1yh1mxy8p7-playwright-core-1.59.1');
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_BIN ?? '/nix/store/flqqsdvs8l0l86zwacyardqfi9ayz3qg-chromium-153.0.8010.52/bin/chromium', timeout: 20_000, env: { ...process.env, FONTCONFIG_FILE: process.env.FONTCONFIG_FILE ?? '/home/theo/Workspace/paseo/.dev/browser-review/fonts.conf' } });
  } catch (error) {
    try { if (browser) await browser.close(); } finally { await closeServer(); }
    throw error;
  }
  return {
    metadata: { compilerPath, dependencies, disclosure: 'Current host-compiled components with real React hooks/RN Web; synthetic single-host state and mock RPC only; no daemon.' },
    async page(viewport = { width: 1440, height: 1100 }) {
      const page = await browser.newPage({ viewport, colorScheme: 'dark', timezoneId: 'UTC' });
      page.setDefaultTimeout(10_000);
      page.setDefaultNavigationTimeout(10_000);
      const errors = [], externalRequests = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin !== `http://127.0.0.1:${server.address().port}`) { externalRequests.push(url.href); return route.abort(); }
        return route.continue();
      });
      await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'networkidle' });
      await page.getByRole('tab', { name: /^Agents/ }).waitFor();
      return { page, errors, externalRequests, async assertClean() {
        assert.deepEqual(errors, [], 'no browser errors');
        assert.deepEqual(externalRequests, [], 'no external requests');
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'no horizontal viewport overflow');
      } };
    },
    async close() {
      if (closed) return;
      closed = true;
      try { await browser.close(); }
      finally { await closeServer(); }
    },
  };
}
export async function enterAgents(page) {
  await page.getByRole('tab', { name: /^Agents/ }).click();
  await page.getByRole('button', { name: 'Select', exact: true }).waitFor();
}
export async function selectCompatible(page) {
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  for (const title of ['Review API integration', 'Write onboarding guide', 'Refactor settings page']) await page.getByRole('checkbox', { name: `Select ${title}`, exact: true }).click();
  await page.getByRole('button', { name: 'Change account… (3)', exact: true }).waitFor();
}
export async function selectMixedProviders(page) {
  await selectCompatible(page);
  await page.getByRole('checkbox', { name: 'Select Pi ChatGPT review', exact: true }).click();
  await page.getByRole('button', { name: 'Change provider… (4)', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Cancel selection', exact: true }).scrollIntoViewIfNeeded();
}
