import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { GhStatusResponse } from '../../../common/gh.js';
import { withChromiumFixture } from '../../support/chromium-fixture.js';

test('mobile opens the global PR inbox despite a cached failed GitHub check', async () => {
  await withChromiumFixture('pull-request-inbox-access', async ({ page, integration, assertNoBrowserErrors }) => {
    let statusChecks = 0;
    let repaired = false;
    await page.route('**/api/v1/gh/status?*', route => {
      statusChecks++;
      const status: GhStatusResponse = repaired
        ? { available: true, authenticated: true, reason: 'authenticated', login: 'synthetic-viewer', host: 'github.com' }
        : { available: false, authenticated: false, reason: 'gh_missing' };
      return route.fulfill({ json: { ...status, executorId: 'local', instanceId: 'synthetic-instance' } });
    });
    const capture = async (name: string) => {
      const directory = process.env.GARCON_SCREENSHOT_DIR;
      if (!directory) return;
      await mkdir(directory, { recursive: true });
      await page.screenshot({ path: join(directory, `${name}.png`) });
    };
    await page.goto(integration.garcon.baseUrl);
    await page.getByRole('button', { name: 'More actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
    await settings.getByRole('tab', { name: 'GitHub', exact: true }).click();
    await browserExpect(settings.getByText('Not installed', { exact: true })).toBeVisible();
    repaired = true;
    await page.keyboard.press('Escape');
    await browserExpect(settings).toBeHidden();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('[data-mobile-current-chat-menu]').getByRole('button').click();
    await browserExpect(page.getByRole('menuitem', { name: 'Open PRs', exact: true })).toBeVisible();
    await capture('inbox-access-menu-mobile');
    await page.getByRole('menuitem', { name: 'Open PRs', exact: true }).click();
    const inbox = page.locator('[data-workspace-surface-id="singleton:pull-requests"][aria-hidden="false"]');
    await browserExpect(inbox.locator('[data-pr-inbox-connect]')).toBeVisible();
    expect(statusChecks).toBe(1);
    await capture('inbox-access-mobile');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole('tab', { name: 'PRs', exact: true }).click();
    await browserExpect(inbox.locator('[data-pr-inbox-connect]')).toBeVisible();
    await capture('inbox-access-desktop');
    assertNoBrowserErrors();
  }, undefined, { executionBackend: 'in-process' });
}, 120_000);
