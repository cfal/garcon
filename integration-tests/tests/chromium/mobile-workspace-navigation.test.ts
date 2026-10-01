import { expect, test } from 'bun:test';
import type { GhStatusResponse } from '../../../common/gh.js';
import type { PullRequestListResult } from '../../../server/runtime/gh/gh-types.js';
import type { GitExecutorScope } from '../../../common/git-execution.js';
import { withChromiumFixture } from '../../support/chromium-fixture.js';

test('keeps the mobile shell full height across non-keyboard viewport discrepancies and resume', async () => {
  await withChromiumFixture('mobile-viewport-resume', async (fixture) => {
    const { page, context, integration } = fixture;
    await page.setViewportSize({ width: 390, height: 800 });
    await context.addInitScript(() => {
      Object.defineProperties(window.visualViewport!, {
        height: { configurable: true, value: 756 },
        offsetTop: { configurable: true, value: 0 },
      });
    });
    await page.goto(integration.garcon.baseUrl, { waitUntil: 'domcontentloaded' });
    const shell = page.locator('.mobile-shell');
    const navigation = page.getByRole('navigation', { name: 'Workspace navigation' });
    const menu = page.locator('[data-mobile-current-chat-menu]').getByRole('button');

    async function assertFullHeight() {
      await navigation.waitFor({ state: 'visible' });
      await page.waitForFunction(() =>
        document.querySelector('.mobile-shell')?.getBoundingClientRect().height === 800,
      );
      const bounds = await shell.boundingBox();
      expect(bounds!.y).toBe(0);
      expect(bounds!.height).toBe(800);
      const tabs = await navigation.boundingBox();
      expect(tabs!.y + tabs!.height).toBe(800);
      const headerControl = await menu.boundingBox();
      expect(headerControl!.y).toBeGreaterThanOrEqual(0);
      expect(headerControl!.y + headerControl!.height).toBeLessThan(tabs!.y);
      await menu.click();
      await page.getByRole('menuitem', { name: 'Open Chat Map', exact: true }).click();
      await page.locator('[data-chat-map-panel]').waitFor({ state: 'visible' });
      await page.getByRole('button', { name: 'Close view', exact: true }).click();
      await navigation.waitFor({ state: 'visible' });
    }

    await assertFullHeight();
    await page.evaluate(() => {
      Object.defineProperties(window.visualViewport!, {
        height: { configurable: true, value: 500 },
        offsetTop: { configurable: true, value: 120 },
      });
      window.visualViewport!.dispatchEvent(new Event('resize'));
    });
    await navigation.waitFor({ state: 'detached' });
    const keyboardBounds = await shell.boundingBox();
    expect(keyboardBounds!.y).toBe(120);
    expect(keyboardBounds!.height).toBe(500);

    await page.evaluate(() => {
      Object.defineProperties(window.visualViewport!, {
        height: { configurable: true, value: 756 },
        offsetTop: { configurable: true, value: 0 },
      });
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    });
    await assertFullHeight();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await assertFullHeight();
    fixture.assertNoBrowserErrors();
  });
}, 120_000);

test('keeps primary mobile tabs compact and opens secondary views from the chat menu', async () => {
  await withChromiumFixture('mobile-workspace-navigation', async (fixture, markPhase) => {
    const { page, integration } = fixture;
    const chatId = integration.newChatId();
    const started = await integration.client.startDirectChat({
      chatId,
      content: 'mobile navigation',
      projectPath: integration.dirs.project,
      agent: integration.directAgents.openAi,
    });
    await integration.client.waitForTurnTerminal(chatId, started.turnId);
    const { executorId, instanceId } = await integration.client.get<GitExecutorScope>('/api/v1/gh/status?executorId=local');
    const scope = { executorId, instanceId } satisfies GitExecutorScope;
    expect(scope.executorId).toBe('local');
    await page.route('**/api/v1/gh/status?executorId=local', (route) =>
      route.fulfill({
        json: {
          ...scope,
          available: true,
          authenticated: true,
          reason: 'authenticated',
          login: 'integration-user',
          host: 'github.com',
        } satisfies GhStatusResponse & GitExecutorScope,
      }),
    );
    await page.route('**/api/v1/gh/pull-requests?*', (route) => {
      expect(new URL(route.request().url()).searchParams.get('executorId')).toBe('local');
      return route.fulfill({
        json: { ...scope, pulls: [], repo: null } satisfies PullRequestListResult & GitExecutorScope,
      });
    });
    await page.setViewportSize({ width: 320, height: 844 });
    await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`, { waitUntil: 'domcontentloaded' });
    const navigation = page.getByRole('navigation', { name: 'Workspace navigation' });
    await navigation.getByRole('button', { name: 'Chat', exact: true }).waitFor();
    expect((await navigation.getByRole('button').allTextContents()).map((label) => label.trim())).toEqual([
      'Menu', 'Chat', 'Git', 'Files', 'Terminal',
    ]);

    for (const width of [320, 390]) {
      markPhase(`checking navigation containment at ${width}px`);
      await page.setViewportSize({ width, height: 844 });
      const clipped = await navigation.evaluate((nav) => {
        const bounds = nav.getBoundingClientRect();
        return Array.from(nav.querySelectorAll('button'))
          .filter((button) => {
            const rect = button.getBoundingClientRect();
            const range = document.createRange();
            range.selectNodeContents(button.querySelector('span')!);
            const text = range.getBoundingClientRect();
            return rect.left < Math.max(0, bounds.left) ||
              rect.right > Math.min(window.innerWidth, bounds.right) ||
              text.left < rect.left || text.right > rect.right;
          })
          .map((button) => button.textContent?.trim());
      });
      expect(clipped).toEqual([]);
    }

    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      for (const [label, kind, selector] of [
        ['Open Chat Map', 'chat-map', '[data-chat-map-panel]'],
        ['Open Canvas', 'chat-canvas', '[data-canvas-panel]'],
        ['Open PRs', 'pull-requests', '[data-pr-panel]'],
      ]) {
        markPhase(`opening and closing ${kind} at ${width}px`);
        for (const exit of ['Back', 'Close view']) {
          await page.locator('[data-mobile-current-chat-menu]').getByRole('button').click();
          await page.getByRole('menuitem', { name: label, exact: true }).click();
          const panel = page.locator(`[data-workspace-surface-id="singleton:${kind}"]`);
          await panel.locator(selector).waitFor({ state: 'visible' });
          expect(await navigation.count()).toBe(0);
          const close = panel.getByRole('button', { name: 'Close view', exact: true });
          const bounds = await close.boundingBox();
          expect(bounds).not.toBeNull();
          expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
          await panel.getByRole('button', { name: exit, exact: true }).click();
          await navigation.waitFor({ state: 'visible' });
          expect(await navigation.getByRole('button').count()).toBe(5);
          if (exit === 'Close view') expect(await panel.count()).toBe(0);
        }
      }
    }

    await page.setViewportSize({ width: 1440, height: 900 });
    await navigation.waitFor({ state: 'detached' });
    expect(await page.locator('[data-mobile-current-chat-menu]').count()).toBe(0);
    fixture.assertNoBrowserErrors();
  });
}, 120_000);

test('keeps mobile workspace commands reachable before selecting a chat', async () => {
  await withChromiumFixture('mobile-workspace-navigation-empty', async ({ page, integration }) => {
    await page.setViewportSize({ width: 320, height: 844 });
    await page.goto(integration.garcon.baseUrl, { waitUntil: 'domcontentloaded' });
    const navigation = page.getByRole('navigation', { name: 'Workspace navigation' });
    for (const [label, selector] of [
      ['Open Chat Map', '[data-chat-map-panel]'],
      ['Open Canvas', '[data-canvas-panel]'],
    ]) {
      await page.locator('[data-mobile-current-chat-menu]').getByRole('button').click();
      expect(await page.locator('[data-composer-shell]').isVisible()).toBe(false);
      expect(await page.getByRole('menuitem', { name: 'Share', exact: true }).count()).toBe(0);
      await page.getByRole('menuitem', { name: label, exact: true }).click();
      await page.locator(selector).waitFor({ state: 'visible' });
      await page.getByRole('button', { name: 'Close view', exact: true }).click();
      await navigation.waitFor({ state: 'visible' });
      expect(await page.locator('[data-composer-shell]').isVisible()).toBe(false);
    }
    await page.getByRole('button', { name: 'New Chat', exact: true }).click();
    await page.getByRole('textbox', { name: 'Project Path', exact: true }).waitFor();
  });
}, 120_000);
