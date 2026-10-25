import { expect, test } from 'bun:test';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { SpaDriver } from '../../support/spa-driver.js';

test.each(['row', 'button'] as const)('sidebar clicks wait for the %s to render', async (missing) => {
  const server = Bun.serve({
    hostname: '0.0.0.0', port: 0,
    fetch: () => new Response('<!doctype html><html><body></body></html>', {
      headers: { 'Content-Type': 'text/html' },
    }),
  });
  try {
    await withE2eFixture(`sidebar-driver-${missing}`, async ({ page, integration }) => {
      const chatId = '1000000000000001';
      await page.goto(`http://127.0.0.1:${server.port}`, { waitUntil: [] });
      await page.evaluate(({ chatId, missing }) => {
        document.body.innerHTML = missing === 'row'
          ? ''
          : `<div data-sidebar-virtual-row="${chatId}"></div>`;
        const querySelectorAll = document.querySelectorAll.bind(document);
        // Keeps the target unavailable until the driver actually attempts its lookup.
        Object.defineProperty(document, 'querySelectorAll', {
          configurable: true,
          value(selector: string) {
            if (selector === '[data-sidebar-virtual-row]') {
              document.documentElement.dataset.sidebarLookup = 'attempted';
            }
            return querySelectorAll(selector);
          },
        });
      }, { chatId, missing });

      const app = new SpaDriver(page, integration);
      const clicked = app.clickSidebarChatById(chatId).then(() => null, (error: unknown) => error);
      await page.waitForFunction(() => document.documentElement.dataset.sidebarLookup === 'attempted');
      await page.evaluate((chatId) => {
        document.body.innerHTML = `<div data-sidebar-virtual-row="${chatId}"><button>
          <span data-slot="sidebar-chat-summary">Synthetic chat</span></button></div>`;
        document.documentElement.dataset.sidebarClicks = '0';
        document.querySelector('button')!.addEventListener('click', () => {
          const root = document.documentElement;
          root.dataset.sidebarClicks = String(Number(root.dataset.sidebarClicks) + 1);
        });
      }, chatId);

      expect(await clicked).toBeNull();
      expect(await page.evaluate(() => document.documentElement.dataset.sidebarClicks)).toBe('1');
    });
  } finally {
    await server.stop(true);
  }
});
