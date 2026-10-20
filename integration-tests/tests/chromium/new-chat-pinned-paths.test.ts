import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { withChromiumFixture } from '../../support/chromium-fixture.js';

for (const executionBackend of ['in-process', 'remote-controller-dials', 'remote-executor-dials'] as const) {
  test(`New Chat picks other executor pins without losing draft or focus (${executionBackend})`, async () => {
    await withChromiumFixture(`new-chat-executor-pins-${executionBackend}`, async ({ page, context, integration, assertNoBrowserErrors }, phase) => {
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
      const trigger = pins.getByRole('button', { name: 'Other executors…', exact: true });
      const picker = page.locator('[data-executor-pins-picker]');
      const path = page.locator('#project-path-input');
      await browserExpect(path).toHaveValue(sharedPath);
      await browserExpect(page.locator('[data-slot="project-path-field"] .text-status-success-foreground')).toBeVisible();
      await browserExpect(trigger).toHaveAttribute('aria-expanded', 'false');
      await browserExpect(picker).toHaveCount(0);
      phase('checking compact inline pins');
      const artifacts = join(import.meta.dirname, '../../artifacts/chromium');
      await mkdir(artifacts, { recursive: true });
      await dialog.screenshot({ path: join(artifacts, `executor-pins-${executionBackend}-desktop-default.png`) });
      await trigger.focus();
      await page.keyboard.press('Space');
      await browserExpect(picker).toBeVisible();
      await browserExpect.poll(() => picker.evaluate(element => element.parentElement?.contains(document.activeElement))).toBe(true);
      await browserExpect(path).toHaveValue(sharedPath);
      await browserExpect(picker.getByRole('group', { name: 'Local', exact: true })).toHaveCount(0);
      const offlinePin = picker.getByRole('button', { name: 'Offline worker: /projects/archive', exact: true });
      await browserExpect(offlinePin).toBeDisabled();
      await browserExpect(offlinePin).toHaveAccessibleDescription('Waiting for connection');
      await browserExpect(picker.getByRole('button', { name: `Offline worker: ${longPath}`, exact: true })).toHaveAttribute('title', longPath);
      await page.keyboard.press('Escape');
      await browserExpect(picker).toHaveCount(0);
      await browserExpect(trigger).toBeFocused();

      phase('dismissing into the prompt without stealing its focus');
      await trigger.click();
      await prompt.click({ position: { x: 12, y: 12 } });
      await browserExpect(picker).toHaveCount(0);
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await browserExpect(prompt).toBeFocused();

      if (client.executorId !== 'local') {
        phase('selecting identical path on the real worker');
        await trigger.click();
        const workerPin = picker.getByRole('button', { name: `Integration worker: ${sharedPath}`, exact: true });
        await workerPin.focus();
        const validated = page.waitForResponse(response => {
          const url = new URL(response.url());
          return url.pathname === '/api/v1/chats/validate-start'
            && url.searchParams.get('executorId') === client.executorId && response.ok();
        });
        await page.keyboard.press('Enter');
        await validated;
        await browserExpect(page.getByText('Loading models...', { exact: true })).toHaveCount(0, { timeout: 20_000 });
        await browserExpect(picker).toHaveCount(0);
        await browserExpect(pins.getByRole('button', { name: sharedPath, exact: true })).toHaveAttribute('aria-pressed', 'true');
        await browserExpect(prompt).toHaveValue('Synthetic retained draft');
      }

      for (const width of [1440, 390, 360]) {
        phase(`checking picker at ${width}px`);
        const cdp = await context.newCDPSession(page);
        await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: width < 500 });
        await page.setViewportSize({ width, height: 900 });
        await trigger.click();
        await browserExpect(picker).toBeVisible();
        await browserExpect.poll(() => picker.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
        const surface = width < 500
          ? page.getByRole('dialog', { name: 'Other executors…', exact: true })
          : page.locator('[data-slot="popover-content"]').filter({ has: picker });
        await browserExpect(surface).toBeVisible();
        if (width < 500) {
          await browserExpect.poll(() => trigger.evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
          const box = await surface.boundingBox();
          expect(box).not.toBeNull();
          expect(box!.y + box!.height).toBeCloseTo(900, 0);
        }
        await page.screenshot({ path: join(artifacts, `executor-pins-${executionBackend}-${width}-picker.png`) });
        await page.keyboard.press('Escape');
        await browserExpect(picker).toHaveCount(0);
        await browserExpect(trigger).toBeFocused();
        await cdp.detach();
      }

      phase('reconciling live settings without losing draft or changing executor');
      await trigger.click();
      await client.put('/api/v1/app/settings', { paths: {
        byExecutor: { [offline.id]: { pinnedPaths: ['/projects/replacement'] } },
      } });
      await browserExpect(picker.getByRole('button', { name: 'Offline worker: /projects/replacement', exact: true })).toBeVisible();
      await browserExpect(offlinePin).toHaveCount(0);
      await page.keyboard.press('Escape');
      await browserExpect(trigger).toBeFocused();
      await browserExpect(prompt).toHaveValue('Synthetic retained draft');
      await browserExpect(path).toHaveValue(sharedPath);
      phase('retaining focused trigger when the final other pin disappears');
      await client.put('/api/v1/app/settings', { paths: {
        ...(client.executorId === 'local' ? {} : { pinnedProjectPaths: [] }),
        byExecutor: { [offline.id]: { pinnedPaths: [] } },
      } });
      await browserExpect(trigger).toBeFocused();
      await page.keyboard.press('Space');
      await browserExpect(picker.getByText('No pinned paths on other executors.')).toBeVisible();
      await page.keyboard.press('Escape');
      await browserExpect(trigger).toBeFocused();
      await page.keyboard.press('Tab');
      await browserExpect(trigger).not.toBeFocused();
      await browserExpect(trigger).toHaveAttribute('aria-expanded', 'false');
      expect((await client.listChats()).sessions).toEqual([]);
      assertNoBrowserErrors();
    }, async ({ page }) => page.evaluate(() => ({ activeElement: document.activeElement?.outerHTML })), { executionBackend });
  }, 120_000);
}

test('executor pin picker retains touch targets with a fine primary pointer and secondary touchscreen', async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--blink-settings=primaryPointerType=4,availablePointerTypes=6'],
  });
  try {
    await withChromiumFixture('new-chat-executor-pins-hybrid', async ({ page, integration, assertNoBrowserErrors }) => {
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
      const trigger = pins.getByRole('button', { name: 'Other executors…', exact: true });
      const pin = pins.getByRole('button', { name: dirs.project, exact: true });
      await browserExpect(page.locator('[data-slot="project-path-field"] .text-status-success-foreground')).toBeVisible();
      for (const control of [trigger, pin]) {
        await browserExpect.poll(() => control.evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
      }
      await trigger.click();
      const groupedPin = page.getByRole('button', { name: 'Touchscreen worker: /projects/atlas', exact: true });
      await browserExpect.poll(() => groupedPin.evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
      await page.keyboard.press('Escape');
      await browserExpect(trigger).toBeFocused();
      await client.put('/api/v1/app/settings', { paths: { byExecutor: { [worker.id]: { pinnedPaths: [] } } } });
      await browserExpect(trigger).toBeFocused();
      await page.keyboard.press('Tab');
      await browserExpect(trigger).not.toBeFocused();
      await browserExpect(trigger).toHaveAttribute('aria-expanded', 'false');
      assertNoBrowserErrors();
    }, undefined, {}, browser);
  } finally {
    await browser.close();
  }
}, 120_000);
