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

test('two Garcon pages suppress notifications while either is focused and deliver once when both are unfocused', async () => {
  await withChromiumFixture('browser-notifications-two-pages', async ({ page, context, integration, assertNoBrowserErrors }) => {
    await context.addInitScript(() => {
      const capture = window as typeof window & { notificationTitles: string[]; notificationFocused: boolean; finishedTurns: string[] };
      capture.notificationTitles = []; capture.notificationFocused = false; capture.finishedTurns = [];
      localStorage.setItem('pref_local_settings', JSON.stringify({ browserNotifications: true }));
      class DesktopNotification {
        static permission = 'granted';
        constructor(title: string) { capture.notificationTitles.push(title); }
        close() {}
      }
      const NativeWebSocket = window.WebSocket;
      class ObservedWebSocket extends NativeWebSocket {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          this.addEventListener('message', event => {
            const data = JSON.parse(String(event.data));
            if (data.type === 'agent-run-finished') capture.finishedTurns.push(data.turnId);
          });
        }
      }
      Object.defineProperty(window, 'WebSocket', { value: ObservedWebSocket });
      Object.defineProperty(window, 'Notification', { value: DesktopNotification });
      Object.defineProperty(document, 'hasFocus', { value: () => capture.notificationFocused });
    });
    const ids = [integration.newChatId(), integration.newChatId(), integration.newChatId()];
    for (const chatId of ids) {
      const turn = await integration.client.startDirectChat({ chatId, content: 'Synthetic multi-tab setup', projectPath: integration.dirs.project, agent: integration.directAgents.anthropic });
      await integration.client.waitForTurnTerminal(chatId, turn.turnId);
    }
    await page.goto(`${integration.garcon.baseUrl}/chat/${ids[0]}`);
    await page.getByPlaceholder('Reply...', { exact: true }).waitFor();
    await page.evaluate(() => { (window as typeof window & { notificationFocused: boolean }).notificationFocused = true; });
    const peer = await context.newPage();
    await peer.goto(`${integration.garcon.baseUrl}/chat/${ids[1]}`);
    await peer.getByPlaceholder('Reply...', { exact: true }).waitFor();
    await page.bringToFront();
    const focusedTurn = await integration.client.runDirectChat({ chatId: ids[2]!, content: 'Synthetic focused completion', agent: integration.directAgents.anthropic });
    await integration.client.waitForTurnTerminal(ids[2]!, focusedTurn.turnId);
    await expect.poll(async () => Promise.all([page, peer].map(tab => tab.evaluate(turnId => (window as typeof window & { finishedTurns: string[] }).finishedTurns.includes(turnId), focusedTurn.turnId!)))).toEqual([true, true]);
    await Promise.all([page, peer].map(tab => tab.evaluate(() => navigator.locks.request('garcon-browser-notifications', () => {}))));
    const titles = () => Promise.all([page, peer].map(tab => tab.evaluate(() => (window as typeof window & { notificationTitles: string[] }).notificationTitles)));
    expect((await titles()).flat()).toEqual([]);
    await page.evaluate(() => { (window as typeof window & { notificationFocused: boolean }).notificationFocused = false; });
    const unfocusedTurn = await integration.client.runDirectChat({ chatId: ids[2]!, content: 'Synthetic unfocused completion', agent: integration.directAgents.anthropic });
    await integration.client.waitForTurnTerminal(ids[2]!, unfocusedTurn.turnId);
    await expect.poll(async () => (await titles()).flat()).toEqual(['Garcon: chat completed']);
    assertNoBrowserErrors();
    await peer.close();
  });
}, 180_000);
