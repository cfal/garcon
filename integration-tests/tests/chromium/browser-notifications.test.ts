import { test } from 'bun:test';
import { expect } from 'playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { withChromiumFixture } from '../../support/chromium-fixture.js';

test('browser notifications enable explicitly and route a background completion at the root', async () => {
  await withChromiumFixture('browser-notifications', async ({ page, context, integration, assertNoBrowserErrors }) => {
    await context.addInitScript(() => {
      const capture = window as typeof window & { notificationTitles: string[]; permissionRequests: number };
      capture.notificationTitles = []; capture.permissionRequests = 0;
      class DesktopNotification {
        static permission = 'default';
        static async requestPermission() { capture.permissionRequests++; DesktopNotification.permission = 'granted'; return 'granted'; }
        constructor(title: string) { capture.notificationTitles.push(title); }
        close() {}
      }
      Object.defineProperty(window, 'Notification', { value: DesktopNotification });
      Object.defineProperty(document, 'hasFocus', { value: () => false });
    });
    const ids = [integration.newChatId(), integration.newChatId()];
    for (const chatId of ids) {
      const turn = await integration.client.startDirectChat({ chatId, content: 'Synthetic notification review', projectPath: integration.dirs.project, agent: integration.directAgents.anthropic });
      await integration.client.waitForTurnTerminal(chatId, turn.turnId);
    }
    await page.goto(`${integration.garcon.baseUrl}/chat/${ids[0]}`);
    await page.getByPlaceholder('Reply...', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'More actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
    await settings.getByRole('tab', { name: 'Notifications', exact: true }).click();
    const requests = () => page.evaluate(() => (window as typeof window & { permissionRequests: number }).permissionRequests);
    expect(await requests()).toBe(0);
    await settings.getByRole('button', { name: 'Enable browser notifications' }).click();
    await expect(settings.getByRole('checkbox', { name: 'Notify for completion and permission requests' })).toBeChecked();
    expect(await requests()).toBe(1);
    const artifacts = join(import.meta.dirname, '../../artifacts/chromium');
    await mkdir(artifacts, { recursive: true });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await settings.screenshot({ path: join(artifacts, `browser-notifications-${width}.png`) });
    }
    const turn = await integration.client.runDirectChat({ chatId: ids[1]!, content: 'Synthetic private content', agent: integration.directAgents.anthropic });
    await integration.client.waitForTurnTerminal(ids[1]!, turn.turnId);
    await expect.poll(() => page.evaluate(() => (window as typeof window & { notificationTitles: string[] }).notificationTitles)).toEqual(['Garcon: chat completed']);
    assertNoBrowserErrors();
  });
}, 180_000);
