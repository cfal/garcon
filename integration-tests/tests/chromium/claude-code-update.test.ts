import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withChromiumFixture } from '../../support/chromium-fixture.js';

test.each(['in-process', 'remote-controller-dials', 'remote-executor-dials'] as const)(
  'Claude Code updates from provider Settings on its executor (%s)',
  async (executionBackend) => {
    await withChromiumFixture(`claude-code-update-${executionBackend}`, async ({ page, integration, assertNoBrowserErrors }, phase) => {
      let statusRequests = 0;
      page.on('request', (request) => {
        if (new URL(request.url()).pathname === '/api/v1/agents/installation') statusRequests++;
      });
      const denied = await fetch(`${integration.garcon.baseUrl}/api/v1/agents/installation/update`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: 'claude', executorId: integration.client.executorId }),
      });
      expect(denied.status).toBe(401);
      await page.goto(integration.garcon.baseUrl);
      await page.getByRole('button', { name: 'More actions', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
      const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
      await settings.getByRole('tab', { name: 'Providers', exact: true }).click();
      expect(statusRequests).toBe(0);
      const native = settings.getByRole('region', { name: executionBackend === 'in-process' ? 'Local' : 'Integration worker', exact: true }).first();
      await native.getByRole('button', { name: /Claude/ }).click();
      const panel = native.getByRole('region', { name: 'Claude Code', exact: true });
      await browserExpect(panel.getByText('Installed version: 2.1.207', { exact: true })).toBeVisible();
      await browserExpect(panel.getByText('Claude Code 2.1.207 is unsupported. Upgrade to 2.1.238 or newer.', { exact: true })).toBeVisible();
      expect(statusRequests).toBe(1);
      phase('reject a stale installation instance through authenticated HTTP');
      const stale = await integration.client.fetch('/api/v1/agents/installation/update', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: 'claude', executorId: integration.client.executorId, instanceId: 'stale-instance' }),
      });
      expect(stale.status).toBe(503);
      expect(await stale.json()).toMatchObject({ errorCode: 'STALE_RESOURCE', retryable: false });
      expect(await Bun.file(join(integration.executionDirs.home, 'claude-updates')).exists()).toBe(false);
      const updateRequest = page.waitForRequest((request) => request.method() === 'POST'
        && new URL(request.url()).pathname === '/api/v1/agents/installation/update');
      const artifacts = join(import.meta.dirname, '../../artifacts/chromium');
      await mkdir(artifacts, { recursive: true });
      for (const width of [1440, 390, 320]) {
        phase(`Claude update panel at ${width}px`);
        await page.setViewportSize({ width, height: 900 });
        await panel.scrollIntoViewIfNeeded();
        expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
        await page.screenshot({ path: join(artifacts, `claude-code-update-${executionBackend}-${width}.png`) });
      }
      phase('update and verify the configured launcher');
      await panel.getByRole('button', { name: 'Update Claude Code', exact: true }).click();
      const payload = (await updateRequest).postDataJSON();
      expect(payload).toMatchObject({ agentId: 'claude', executorId: integration.client.executorId, instanceId: expect.any(String) });
      expect(payload.instanceId).not.toBe('stale-instance');
      await browserExpect(panel.getByText('Claude Code 2.1.285 is ready for new sessions.', { exact: true })).toBeVisible();
      await browserExpect(panel.getByText('Installed version: 2.1.285', { exact: true })).toBeVisible();
      const updates = await readFile(join(integration.executionDirs.home, 'claude-updates'), 'utf8');
      expect(updates.trim().split('\n')).toHaveLength(1);
      expect(updates.trim()).toBe(executionBackend === 'in-process' ? 'controller' : 'executor');
      await panel.getByRole('button', { name: 'Refresh version', exact: true }).click();
      await browserExpect(panel.getByText('Installed version: 2.1.285', { exact: true })).toBeVisible();
      assertNoBrowserErrors();
    }, undefined, {
      executionBackend,
      resolveServerEnvironment: (directories) => ({ CLAUDE_BINARY: join(directories.home, 'fake-claude-update') }),
      prepareWorkspace: async (directories) => {
        await writeFile(join(directories.home, 'claude-version'), '2.1.207');
        await writeFile(join(directories.home, 'fake-claude-update'), `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const file = (name) => join(import.meta.dir, name);
if (process.argv[2] === '--version') console.log(readFileSync(file('claude-version'), 'utf8') + ' (Claude Code)');
else if (process.argv[2] === 'auth' && process.argv[3] === 'status') console.log(JSON.stringify({ loggedIn: false }));
else if (process.argv[2] === 'update') {
  appendFileSync(file('claude-updates'), (process.env.GARCON_RUNTIME ?? 'controller') + '\\n');
  writeFileSync(file('claude-version'), '2.1.285');
  console.log('Synthetic update complete');
} else process.exit(2);
`, { mode: 0o755 });
      },
    });
  },
  120_000,
);
