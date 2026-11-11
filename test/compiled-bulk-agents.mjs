import assert from 'node:assert/strict';
import test from 'node:test';
import {
  enterAgents, selectCompatible, startBulkHarness,
} from '../.dev/accounts-review/bulk-harness.mjs';
const change = page => page.getByRole('button', { name: /^Change account…/ });
const disabled = async locator => assert.equal(await locator.isDisabled(), true);
const enabled = async locator => assert.equal(await locator.isEnabled(), true);
test('compiled same-host bulk Agents UI and source lifetime', { timeout: 120_000 }, async t => {
  const harness = await startBulkHarness();
  async function scenario(name, run) {
    await t.test(name, async () => {
      const session = await harness.page();
      try { await enterAgents(session.page); await run(session.page); await session.assertClean(); }
      finally { await session.page.close(); }
    });
  }
  try {
    await scenario('selection excludes busy and non-Pi; no provider action', async page => {
      await page.getByRole('button', { name: 'Select', exact: true }).click();
      await disabled(change(page));
      assert.equal(await page.getByRole('button', { name: /^Change provider/ }).count(), 0);
      await disabled(page.getByRole('checkbox', { name: 'Select Working checkout fix', exact: true }));
      await disabled(page.getByRole('checkbox', { name: 'Select Claude individual change', exact: true }));
      await page.getByRole('button', { name: 'Select all eligible', exact: true }).click();
      await enabled(change(page));
      await page.getByRole('button', { name: 'Cancel selection', exact: true }).click();
      assert.deepEqual(await page.evaluate(() => window.__bulkFixture.calls), []);
    });
    await scenario('account action sends selected IDs, reports partial result', async page => {
      await selectCompatible(page); await change(page).click();
      await page.getByText('Change account for 3 agents', { exact: true }).waitFor();
      await page.getByRole('radio', { name: 'Codex Personal', exact: true }).click();
      await page.getByText('1 changed · 1 skipped · 1 failed', { exact: true }).waitFor();
      const calls = await page.evaluate(() => window.__bulkFixture.calls);
      assert.deepEqual(calls.map(call => call.input), [
        { agentId: 'pinned', accountId: 'pi-native:codex:profile:personal', onlyIfIdle: true },
        { agentId: 'fails', accountId: 'pi-native:codex:profile:personal', onlyIfIdle: true },
      ]);
    });
    await scenario('host replacement closes chooser and prevents stale dispatch', async page => {
      await selectCompatible(page); await change(page).click();
      await page.evaluate(() => window.__bulkFixture.setHostId('replacement'));
      await page.getByRole('button', { name: 'Select', exact: true }).waitFor();
      assert.deepEqual(await page.evaluate(() => window.__bulkFixture.calls), []);
    });
  } finally { await harness.close(); }
});
