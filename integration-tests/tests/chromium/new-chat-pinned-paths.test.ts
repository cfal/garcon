import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { withChromiumFixture } from '../../support/chromium-fixture.js';

for (const executionBackend of ['in-process', 'remote-controller-dials', 'remote-executor-dials'] as const) {
  test(`New Chat selects saved projects with retained drafts (${executionBackend})`, async () => {
    await withChromiumFixture(`new-chat-saved-projects-${executionBackend}`, async ({ page, context, integration, assertNoBrowserErrors }, phase) => {
      const { client, dirs } = integration;
      const offline = await client.post<{ id: string }>('/api/v1/executors', {
        label: 'Offline worker', direction: 'executor-connects', noTls: true,
      });
      const sharedPath = dirs.project;
      const longPath = '/projects/' + 'synthetic-project-'.repeat(30);
      await client.put('/api/v1/app/settings', { paths: {
        recentProjectPaths: [sharedPath], pinnedProjectPaths: ['/projects/atlas'],
        byExecutor: {
          ...(client.executorId === 'local' ? {} : { [client.executorId]: {
            defaultPath: sharedPath, pinnedPaths: [sharedPath, '/projects/garcon'],
          } }),
          [offline.id]: { pinnedPaths: ['/projects/archive', longPath] },
        },
      } });
      await page.goto(integration.garcon.baseUrl);
      await browserExpect(page.getByRole('dialog', { name: 'New Chat', exact: true })).toBeVisible();
      const dialog = page.getByRole('dialog', { name: 'New Chat', exact: true });
      await browserExpect(dialog.getByRole('heading', { name: 'What would you like to work on?' })).toBeVisible();
      const prompt = dialog.getByPlaceholder('How can I help you today?');
      await prompt.fill('Synthetic retained draft');
      const pins = dialog.getByRole('region', { name: 'Saved and recent projects', exact: true });
      const localPin = pins.getByRole('button', { name: sharedPath, exact: true });
      const worktrees = dialog.getByRole('region', { name: 'Worktrees', exact: true });
      phase('validating a selected project without advancing the debounce clock');
      await page.clock.install();
      await page.clock.pauseAt(new Date());
      const selectedPinValidation = page.waitForResponse(response => {
        const url = new URL(response.url());
        return url.pathname === '/api/v1/chats/validate-start'
          && url.searchParams.get('executorId') === 'local' && response.ok();
      });
      await localPin.dispatchEvent('click');
      await selectedPinValidation;
      await page.clock.resume();
      await browserExpect(localPin).toHaveAttribute('aria-pressed', 'true');
      await browserExpect(worktrees.getByText(sharedPath, { exact: true })).toBeVisible();
      const offlinePin = pins.getByRole('button', { name: 'Offline worker: /projects/archive', exact: true });
      await browserExpect(offlinePin).toBeDisabled();
      await browserExpect(offlinePin).toHaveAccessibleDescription('Waiting for connection');
      await browserExpect(pins.getByRole('button', { name: `Offline worker: ${longPath}`, exact: true })).toContainText(longPath);

      if (client.executorId !== 'local') {
        phase('selecting the identical path on the real worker with Enter');
        const workerPin = pins.getByRole('button', { name: `Integration worker: ${sharedPath}`, exact: true });
        await workerPin.focus();
        const validated = page.waitForResponse(response => {
          const url = new URL(response.url());
          return url.pathname === '/api/v1/chats/validate-start'
            && url.searchParams.get('executorId') === client.executorId && response.ok();
        });
        await page.clock.pauseAt(new Date());
        await page.keyboard.press('Enter');
        await validated;
        await page.clock.resume();
        await browserExpect(workerPin).toHaveAttribute('aria-pressed', 'true');
        await browserExpect(localPin).toHaveAttribute('aria-pressed', 'false');
        await browserExpect(prompt).toBeFocused();
        await browserExpect(worktrees.getByText(sharedPath, { exact: true })).toBeVisible();
      }
      await browserExpect(prompt).toHaveValue('Synthetic retained draft');
      const artifacts = join(import.meta.dirname, '../../artifacts/chromium');
      await mkdir(artifacts, { recursive: true });
      for (const width of [1440, 390, 360]) {
        phase(`checking landing layout at ${width}px`);
        const cdp = await context.newCDPSession(page);
        await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: width < 500 });
        await page.setViewportSize({ width, height: 900 });
        await browserExpect.poll(() => page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(width < 500);
        await browserExpect.poll(() => pins.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
        await browserExpect.poll(() => dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
        expect(await localPin.evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
        const box = await dialog.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.x).toBeCloseTo(0, 0);
        expect(box!.width).toBeCloseTo(width, 0);
        await prompt.scrollIntoViewIfNeeded();
        await browserExpect(prompt).toBeVisible();
        await page.screenshot({ path: join(artifacts, `saved-projects-${executionBackend}-${width}.png`) });
        await cdp.detach();
      }
      phase('reconciling live settings without losing the draft');
      await client.put('/api/v1/app/settings', { paths: {
        byExecutor: { [offline.id]: { pinnedPaths: ['/projects/replacement'] } },
      } });
      await browserExpect(pins.getByRole('button', { name: 'Offline worker: /projects/replacement', exact: true })).toBeDisabled();
      await browserExpect(offlinePin).toHaveCount(0);
      await browserExpect(prompt).toHaveValue('Synthetic retained draft');
      phase('retaining the selected project when saved projects are removed');
      await client.put('/api/v1/app/settings', { paths: {
        pinnedProjectPaths: [], recentProjectPaths: [],
        byExecutor: {
          ...(client.executorId === 'local' ? {} : { [client.executorId]: { pinnedPaths: [] } }),
          [offline.id]: { pinnedPaths: [] },
        },
      } });
      await browserExpect(pins.locator('[data-slot="new-chat-project-card"]')).toHaveCount(1);
      await browserExpect(pins.getByRole('button', { pressed: true })).toHaveCount(1);
      expect((await client.listChats()).sessions).toEqual([]);
      await dialog.getByRole('button', { name: 'Close', exact: true }).click();
      await browserExpect(dialog).toHaveCount(0);
      await page.getByRole('button', { name: 'New Chat', exact: true }).first().click();
      await browserExpect(prompt).toHaveValue('Synthetic retained draft');
      assertNoBrowserErrors();
    }, async ({ page }) => page.evaluate(() => ({ activeElement: document.activeElement?.outerHTML })), { executionBackend });
  }, 120_000);
}

test('saved projects remain accessible with a fine primary pointer and secondary touchscreen', async () => {
  const browser = await chromium.launch({ headless: true, args: ['--blink-settings=primaryPointerType=4,availablePointerTypes=6'] });
  try {
    await withChromiumFixture('new-chat-saved-projects-hybrid', async ({ page, integration, assertNoBrowserErrors }) => {
      const { client, dirs } = integration;
      await client.put('/api/v1/app/settings', { paths: { pinnedProjectPaths: [dirs.project] } });
      await page.goto(integration.garcon.baseUrl);
      await browserExpect(page.getByRole('dialog', { name: 'New Chat', exact: true })).toBeVisible();
      expect(await page.evaluate(() => ({ primaryFine: matchMedia('(pointer: fine)').matches, anyCoarse: matchMedia('(any-pointer: coarse)').matches }))).toEqual({ primaryFine: true, anyCoarse: true });
      const pin = page.getByRole('region', { name: 'Saved and recent projects' }).getByRole('button', { name: dirs.project, exact: true });
      await pin.focus();
      await page.keyboard.press('Space');
      await browserExpect(pin).toHaveAttribute('aria-pressed', 'true');
      await browserExpect(page.getByPlaceholder('How can I help you today?')).toBeFocused();
      expect(await pin.evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
      assertNoBrowserErrors();
    }, undefined, {}, browser);
  } finally {
    await browser.close();
  }
}, 120_000);
