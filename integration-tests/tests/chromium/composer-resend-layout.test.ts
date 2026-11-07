import { expect, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect as browserExpect } from 'playwright/test';
import type { Route } from 'playwright';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { collapseCanonicalFilesWindow } from '../../support/chromium-workspace.js';
import { Deferred, withTimeout } from '../../support/deferred.js';
import { claudeText } from '../../support/fake-claude-model.js';
import { liveClaudeStartRequest } from '../../support/live-claude.js';
import { startScriptedClaudeTestEnvironment } from '../../support/scripted-claude.js';
import { waitForDisplayIdle } from '../../support/transcript-display-browser.js';

test('source resend reads add no status row or toolbar slot and preserve native-composer focus and geometry', async () => {
  const environment = await startScriptedClaudeTestEnvironment();
  try {
    await withChromiumFixture('composer-resend-layout', async ({ page, integration }, phase) => {
      const chatId = integration.newChatId();
      environment.model.scriptTurn([claudeText('Synthetic completed answer')]);
      const started = await integration.client.startChat(liveClaudeStartRequest({ chatId,
        projectPath: integration.dirs.project, command: 'Synthetic layout setup', permissionMode: 'bypassPermissions' }));
      await integration.client.waitForTurnTerminal(chatId, started.turnId);
      const artifacts = join(import.meta.dirname, '../../artifacts/chromium');
      await mkdir(artifacts, { recursive: true });
      for (const width of [1440, 390, 320]) {
        phase(`native composer with pending resend read at ${width}px`);
        await page.setViewportSize({ width, height: 900 });
        const entered = new Deferred<void>(), release = new Deferred<void>();
        const path = '**/api/v1/chats/transcript-display/resend';
        const hold = async (route: Route) => {
          if (route.request().postDataJSON().chatId !== chatId) return route.continue();
          const response = await route.fetch();
          entered.resolve();
          await release.promise;
          await route.fulfill({ response });
        };
        await page.route(path, hold);
        try {
          await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
          if (width >= 1024) await collapseCanonicalFilesWindow(page);
          await waitForDisplayIdle(page);
          await withTimeout(entered.promise, 20_000, () => 'Missing source resend read');
          const composer = page.locator('[data-composer]:visible');
          const editor = composer.locator('textarea');
          await editor.fill('Synthetic retained draft');
          await editor.evaluate(input => (input as HTMLTextAreaElement).setSelectionRange(4, 9));
          const original = await editor.elementHandle();
          const before = await composer.boundingBox();
          const completed = page.waitForResponse(response => response.url().endsWith('/transcript-display/resend')
            && response.request().postDataJSON().chatId === chatId);
          release.resolve();
          expect((await completed).ok()).toBe(true);
          await waitForDisplayIdle(page);
          expect(await composer.boundingBox()).toEqual(before);
          expect(await original!.evaluate(input => input instanceof HTMLTextAreaElement && input.isConnected && document.activeElement === input
            && input.selectionStart === 4 && input.selectionEnd === 9)).toBe(true);
          await browserExpect(editor).toHaveValue('Synthetic retained draft');
          await browserExpect(composer.getByRole('button', { name: /^(Previous page|Next page|Resend status)$/ })).toHaveCount(0);
          const toolbar = composer.locator('[data-slot="composer-bottom-bar"]');
          expect(await toolbar.evaluate(element => {
            const outer = element.getBoundingClientRect();
            const buttons = [...element.querySelectorAll('button')].filter(button => button.checkVisibility({ checkVisibilityCSS: true })
              && !button.closest('[aria-hidden="true"]'));
            const rectangles = buttons.map(button => button.getBoundingClientRect());
            return rectangles.every((rect, index) => rect.width >= 20 && rect.left >= outer.left && rect.right <= outer.right
              && rectangles.slice(index + 1).every(other => rect.right <= other.left || rect.left >= other.right
                || rect.bottom <= other.top || rect.top >= other.bottom));
          })).toBe(true);
          await page.screenshot({ path: join(artifacts, `composer-resend-layout-${width}.png`) });
        } finally { release.resolve(); await page.unroute(path, hold); }
      }
      environment.model.assertSettled();
    }, undefined, { serverEnvironment: environment.serverEnvironment });
  } finally { environment.dispose(); }
}, 180_000);
