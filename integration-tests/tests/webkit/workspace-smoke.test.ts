import { expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect as browserExpect, webkit } from 'playwright/test';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { requireCurrentWebBuild } from '../../support/web-build-gate.js';
import { withTimeout } from '../../support/deferred.js';

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test(`WebKit login, chat delivery and reload at ${viewport.width}px`, async () => {
    await requireCurrentWebBuild();
    await withIntegrationFixture(`webkit-workspace-${viewport.width}`, async integration => {
      const browser = await webkit.launch({ headless: true, timeout: 20_000 });
      let failed = false;
      try {
        const context = await browser.newContext({ viewport, serviceWorkers: 'block', hasTouch: viewport.width === 390 });
        const errors: string[] = [];
        context.on('weberror', event => errors.push(`pageerror: ${event.error().message}`));
        context.on('console', message => {
          // WebKit reports the Chromium-only virtual-keyboard hint as an error.
          if (message.type() === 'error' && message.text() !== 'Viewport argument key "interactive-widget" not recognized and ignored.') {
            errors.push(`console.error: ${message.text()}`);
          }
        });
        const page = await context.newPage();
        page.setDefaultTimeout(15_000);
        page.setDefaultNavigationTimeout(20_000);
        try {
          const chatId = integration.newChatId();
          const turn = await integration.client.startDirectChat({
            chatId, content: 'Synthetic WebKit seed', projectPath: integration.dirs.project,
            agent: integration.directAgents.anthropic,
          });
          await integration.client.waitForTurnTerminal(chatId, turn.turnId);
          await page.goto(`${integration.garcon.baseUrl}/login?returnTo=${encodeURIComponent(`/chat/${chatId}`)}`);
          await page.getByLabel('Username', { exact: true }).fill(integration.garcon.credentials!.username);
          await page.getByLabel('Password', { exact: true }).fill(integration.garcon.credentials!.password);
          await page.getByRole('button', { name: 'Sign in', exact: true }).click();
          await browserExpect(page.getByRole('button', { name: 'Sign in', exact: true })).toHaveCount(0);
          await browserExpect(page).toHaveURL(`${integration.garcon.baseUrl}/chat/${chatId}`);
          const composer = page.locator('[data-composer]');
          const editor = page.getByRole('textbox', { name: 'Formatted message' });
          await browserExpect(editor).toBeVisible();
          await editor.fill('Synthetic WebKit follow-up');
          const cursor = integration.client.markEvents();
          await composer.getByRole('button', { name: 'Send message', exact: true }).click();
          await browserExpect.poll(async () => (await integration.client.getMessages(chatId)).messages
            .flatMap(row => row.message.type === 'user-message' ? [row.message.content] : []))
            .toContain('Synthetic WebKit follow-up');
          await integration.client.waitForProcessing(chatId, false, { afterIndex: cursor });
          await browserExpect(page.getByText('Synthetic WebKit follow-up', { exact: true })).toBeVisible();
          await editor.fill('Synthetic persisted WebKit draft');
          // Reload should test persistence, not interrupt the debounced read-receipt request.
          await browserExpect.poll(async () => {
            const chat = (await integration.client.listChats()).sessions.find(chat => chat.id === chatId);
            return Boolean(chat?.activity.lastReadAt && chat.activity.lastActivityAt
              && chat.activity.lastReadAt >= chat.activity.lastActivityAt);
          }, { timeout: 15_000 }).toBe(true);
          await page.reload();
          await browserExpect(editor).toHaveText('Synthetic persisted WebKit draft');
          await browserExpect(page.getByText('Synthetic WebKit follow-up', { exact: true })).toBeVisible();
          expect(await composer.evaluate(element => {
            const bounds = element.getBoundingClientRect();
            return bounds.left >= 0 && bounds.right <= innerWidth + 1 && bounds.bottom <= innerHeight + 1;
          })).toBe(true);
          expect(errors).toEqual([]);
        } catch (error) {
          const artifacts = join(import.meta.dir, '../../artifacts/webkit');
          await mkdir(artifacts, { recursive: true }).catch(() => undefined);
          const prefix = join(artifacts, `workspace-${viewport.width}`);
          await page.screenshot({ path: `${prefix}.png`, fullPage: true, timeout: 3_000 }).catch(() => undefined);
          await writeFile(`${prefix}.json`, JSON.stringify({
            error: error instanceof Error
              ? { name: error.name, message: error.message, stack: error.stack }
              : String(error),
            errors,
            url: page.url(),
          }, null, 2)).catch(() => undefined);
          throw error;
        }
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        try {
          await withTimeout(browser.close(), 10_000, () => 'WebKit browser did not close.');
        } catch (error) {
          if (!failed) throw error;
          console.error(error);
        }
      }
    });
  }, 120_000);
}
