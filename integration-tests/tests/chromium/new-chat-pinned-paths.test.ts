import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { withChromiumFixture } from '../../support/chromium-fixture.js';

for (const executionBackend of ['in-process', 'remote-controller-dials', 'remote-executor-dials'] as const) {
  test(`New Chat browses machine pins without changing execution until a pin is selected (${executionBackend})`, async () => {
    await withChromiumFixture(`new-chat-machine-pins-${executionBackend}`, async ({ page, context, integration, assertNoBrowserErrors }, phase) => {
      const { client, dirs } = integration;
      const offline = await client.post<{ id: string }>('/api/v1/executors', {
        label: 'Offline worker', direction: 'executor-connects', noTls: true,
      });
      const sharedPath = dirs.project;
      const longPath = '/projects/' + 'synthetic-project-'.repeat(30);
      await client.put('/api/v1/app/settings', { paths: {
        recentProjectPaths: [sharedPath], pinnedProjectPaths: [sharedPath, '/projects/atlas'],
        byExecutor: {
          ...(client.executorId === 'local' ? {} : { [client.executorId]: {
            defaultPath: sharedPath, pinnedPaths: [sharedPath, '/projects/garcon'],
          } }),
          [offline.id]: { pinnedPaths: ['/projects/archive', longPath] },
        },
      } });
      await page.goto(integration.garcon.baseUrl);
      await page.getByRole('button', { name: 'New Chat', exact: true }).first().click();
      const dialog = page.getByRole('dialog').filter({ has: page.locator('[data-slot="composer-bottom-bar"]') });
      const prompt = page.getByPlaceholder('How can I help you today?');
      await prompt.fill('Synthetic retained draft');
      const pins = page.getByRole('region', { name: 'Pinned paths', exact: true });
      const toggle = pins.getByRole('button', { name: 'All machines', exact: true });
      await browserExpect(toggle).toHaveAttribute('aria-pressed', 'false');
      const path = page.locator('#project-path-input');
      await browserExpect(path).toHaveValue(sharedPath);
      await browserExpect(page.locator('[data-slot="project-path-field"] .text-status-success-foreground')).toBeVisible();
      phase('checking default compact view');
      const artifacts = join(import.meta.dirname, '../../artifacts/chromium');
      await mkdir(artifacts, { recursive: true });
      await dialog.screenshot({ path: join(artifacts, `machine-pins-${executionBackend}-desktop-default.png`) });
      await toggle.focus();
      await page.keyboard.press('Space');
      await browserExpect(toggle).toHaveAttribute('aria-pressed', 'true');
      await browserExpect(path).toHaveValue(sharedPath);
      const offlinePin = pins.getByRole('button', { name: 'Offline worker: /projects/archive', exact: true });
      await browserExpect(offlinePin).toBeDisabled();
      await browserExpect(offlinePin).toHaveAccessibleDescription('Waiting for connection');
      await browserExpect(pins.getByRole('button', { name: `Offline worker: ${longPath}`, exact: true })).toHaveAttribute('title', longPath);

      if (client.executorId !== 'local') {
        phase('selecting identical path on the real worker');
        const workerPin = pins.getByRole('button', { name: `Integration worker: ${sharedPath}`, exact: true });
        await workerPin.focus();
        const validated = page.waitForResponse(response => {
          const url = new URL(response.url());
          return url.pathname === '/api/v1/chats/validate-start'
            && url.searchParams.get('executorId') === client.executorId && response.ok();
        });
        await page.keyboard.press('Enter');
        await validated;
        await browserExpect(page.getByText('Loading models...', { exact: true })).toHaveCount(0, { timeout: 20_000 });
        await browserExpect(workerPin).toHaveAttribute('aria-pressed', 'true');
        await browserExpect(pins.getByRole('button', { name: `Local: ${sharedPath}`, exact: true })).toHaveAttribute('aria-pressed', 'false');
        await browserExpect(prompt).toHaveValue('Synthetic retained draft');
      }

      for (const width of [1440, 390, 360]) {
        phase(`checking pins at ${width}px`);
        const cdp = await context.newCDPSession(page);
        await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: width < 500 });
        await page.setViewportSize({ width, height: 900 });
        await browserExpect(toggle).toBeVisible();
        await browserExpect.poll(() => pins.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
        if (width < 500) {
          const button = pins.getByRole('button', { name: `Local: ${sharedPath}`, exact: true });
          await browserExpect.poll(() => button.evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
        }
        await dialog.screenshot({ path: join(artifacts, `machine-pins-${executionBackend}-${width}-all.png`) });
        await cdp.detach();
      }

      phase('reconciling live settings without losing draft or changing machine');
      await client.put('/api/v1/app/settings', { paths: { pinnedProjectPaths: ['/projects/replacement'] } });
      await browserExpect(pins.getByRole('button', { name: 'Local: /projects/replacement', exact: true })).toBeVisible();
      await browserExpect(pins.getByRole('button', { name: `Local: ${sharedPath}`, exact: true })).toHaveCount(0);
      await toggle.click();
      await browserExpect(toggle).toHaveAttribute('aria-pressed', 'false');
      await browserExpect(prompt).toHaveValue('Synthetic retained draft');
      await browserExpect(path).toHaveValue(sharedPath);
      if (client.executorId !== 'local') {
        phase('collapsing to the only pinned machine without losing keyboard focus');
        await client.put('/api/v1/app/settings', { paths: {
          pinnedProjectPaths: [], byExecutor: { [offline.id]: { pinnedPaths: [] } },
        } });
        await toggle.focus();
        await page.keyboard.press('Space');
        await browserExpect(toggle).toHaveAttribute('aria-pressed', 'true');
        await browserExpect(offlinePin).toHaveCount(0);
        await browserExpect(pins.getByRole('button', { name: 'Local: /projects/replacement', exact: true })).toHaveCount(0);
        await page.keyboard.press('Space');
        await browserExpect(toggle).toHaveAttribute('aria-pressed', 'false');
        await browserExpect(toggle).toBeFocused();
        await page.keyboard.press('Tab');
        await browserExpect(pins.getByRole('button', { name: '/projects/garcon', exact: true })).toBeFocused();
        await browserExpect(toggle).toHaveAttribute('aria-pressed', 'false');
      }
      expect((await client.listChats()).sessions).toEqual([]);
      assertNoBrowserErrors();
    }, undefined, { executionBackend });
  }, 120_000);
}

test('machine pins retain touch targets with a fine primary pointer and secondary touchscreen', async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--blink-settings=primaryPointerType=4,availablePointerTypes=6'],
  });
  try {
    await withChromiumFixture('new-chat-machine-pins-hybrid', async ({ page, integration, assertNoBrowserErrors }) => {
      const { client, dirs } = integration;
      const worker = await client.post<{ id: string }>('/api/v1/executors', {
        label: 'Touchscreen worker', direction: 'executor-connects', noTls: true,
      });
      await client.put('/api/v1/app/settings', { paths: {
        pinnedProjectPaths: [dirs.project],
        byExecutor: { [worker.id]: { pinnedPaths: ['/projects/atlas'] } },
      } });
      await page.goto(integration.garcon.baseUrl);
      await page.getByRole('button', { name: 'New Chat', exact: true }).first().click();
      expect(await page.evaluate(() => ({
        primaryFine: matchMedia('(pointer: fine)').matches,
        primaryCoarse: matchMedia('(pointer: coarse)').matches,
        anyCoarse: matchMedia('(any-pointer: coarse)').matches,
      }))).toEqual({ primaryFine: true, primaryCoarse: false, anyCoarse: true });
      const pins = page.getByRole('region', { name: 'Pinned paths' });
      const toggle = pins.getByRole('button', { name: 'All machines', exact: true });
      const pin = pins.getByRole('button', { name: dirs.project, exact: true });
      for (const control of [toggle, pin]) {
        await browserExpect.poll(() => control.evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
      }
      await toggle.click();
      const groupedPin = pins.getByRole('button', { name: `Local: ${dirs.project}`, exact: true });
      await browserExpect.poll(() => groupedPin.evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
      await toggle.click();
      await toggle.focus();
      await client.put('/api/v1/app/settings', { paths: { byExecutor: { [worker.id]: { pinnedPaths: [] } } } });
      await browserExpect(toggle).toBeFocused();
      await page.keyboard.press('Tab');
      await browserExpect(pin).toBeFocused();
      await browserExpect(toggle).toHaveAttribute('aria-pressed', 'false');
      assertNoBrowserErrors();
    }, undefined, {}, browser);
  } finally {
    await browser.close();
  }
}, 120_000);
