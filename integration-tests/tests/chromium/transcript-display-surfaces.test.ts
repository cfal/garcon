import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import { canonicalWorkspaceSnapshot } from '../../../web/src/lib/workspace/canonical-layout.js';
import { serializeWorkspaceLayout } from '../../../web/src/lib/workspace/layout-schema.js';
import { reduceWorkspaceLayout } from '../../../web/src/lib/workspace/workspace-layout.svelte.js';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { createDisplayChat } from '../../support/transcript-display-fixture.js';
import { DISPLAY_FEED, observeDisplayWire } from '../../support/transcript-display-browser.js';

for (const sameChat of [true, false]) {
  test(`a held body read cannot block ${sameChat ? 'another surface of the same chat' : 'another chat during reconnect'}`, async () => {
    await withChromiumFixture(`display-independent-surfaces-${sameChat}`, async fixture => {
      const { integration, page } = fixture;
      const first = await createDisplayChat(integration, 'Synthetic first surface');
      const second = sameChat ? first : await createDisplayChat(integration, 'Synthetic second surface');
      const layout = reduceWorkspaceLayout(canonicalWorkspaceSnapshot(), [
        { type: 'close-window', windowId: 'window-files' },
        { type: 'set-window-chat', windowId: 'window-main', chatId: first },
        ...(!sameChat ? [{ type: 'open-chat-in-new-window' as const, chatId: second, targetWindowId: 'window-main' as const, edge: 'right' as const,
          newWindowId: 'window-right' as const, partitionId: 'partition-display' as const }] : []),
      ]);
      await page.addInitScript(persisted => localStorage.setItem('workspace_layout_v2', JSON.stringify(persisted)), serializeWorkspaceLayout(layout));
      const wire = await observeDisplayWire(page);
      const gate = Promise.withResolvers<void>();
      let heldCount = 0;
      const otherPage = sameChat ? await page.context().newPage() : null;
      const otherErrors: string[] = [];
      otherPage?.on('pageerror', error => otherErrors.push(error.message));
      await page.route('**/api/v1/chats/transcript-display/bodies', async route => {
        if (route.request().postDataJSON().certificate.chatId === first) {
          heldCount++;
          await gate.promise;
        }
        await route.continue();
      });
      try {
        await page.goto(`${integration.garcon.baseUrl}/chat/${first}`);
        await browserExpect.poll(() => heldCount).toBeGreaterThan(0);
        if (otherPage) await otherPage.goto(`${integration.garcon.baseUrl}/chat/${first}`);
        const healthy = (otherPage ?? page).locator(`${DISPLAY_FEED}[aria-busy="false"]`);
        await browserExpect(healthy).toHaveCount(1);
        await browserExpect(healthy.getByText(`echo:Synthetic ${sameChat ? 'first' : 'second'} surface`, { exact: true })).toBeVisible();
        expect(await page.locator(`${DISPLAY_FEED}[aria-busy="true"]`).count()).toBe(1);
        if (!sameChat) {
          const recovered = page.waitForResponse(response => response.url().endsWith('/transcript-display/window')
            && response.request().postDataJSON().chatId === second);
          await wire.reconnect();
          expect((await recovered).ok()).toBe(true);
          await browserExpect(healthy.getByText('echo:Synthetic second surface', { exact: true })).toBeVisible();
          expect(await page.locator(`${DISPLAY_FEED}[aria-busy="true"]`).count()).toBe(1);
        }
      } finally { gate.resolve(); }
      await browserExpect(page.locator(`${DISPLAY_FEED}[aria-busy="false"]`)).toHaveCount(sameChat ? 1 : 2);
      expect(otherErrors).toEqual([]);
      await otherPage?.close();
    });
  }, 120_000);
}
