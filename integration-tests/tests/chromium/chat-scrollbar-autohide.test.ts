import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { authenticateChromiumContext, withChromiumFixture } from '../../support/chromium-fixture.js';

test('chat scrollbar auto-hide preserves scrolling, focus, dragging and viewport geometry', async () => {
  await withChromiumFixture('chat-scrollbar-autohide', async ({ page, browser, integration, watchBrowserErrors }, phase) => {
    const chats: string[] = [];
    for (let index = 0; index < 3; index++) {
      const chatId = integration.newChatId();
      const started = await integration.client.startDirectChat({
        chatId,
        content: index === 2
          ? 'Synthetic short scrollbar fixture'
          : `Synthetic scrollbar fixture ${index}\n\n` + 'Synthetic transcript paragraph for scrolling.\n\n'.repeat(80),
        projectPath: integration.executionDirs.project,
        agent: integration.directAgents.openAi,
      });
      await integration.client.waitForTurnTerminal(chatId, started.turnId);
      chats.push(chatId);
    }
    await page.goto(`${integration.garcon.baseUrl}/chat/${chats[0]}`);
    const viewport = page.locator('[data-chat-scroll-viewport]:visible');
    const root = page.locator('[data-chat-scrollbar-auto-hide]:visible');
    const scrollbar = root.locator('[data-chat-feed-scrollbar]');
    const composer = page.locator('[data-composer]:visible');
    await browserExpect(scrollbar).toBeVisible();
    await browserExpect(root).toHaveAttribute('data-chat-scrollbar-auto-hide', 'true');
    await page.mouse.move(1, 1);
    await browserExpect(scrollbar).toHaveCSS('opacity', '0');

    const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
    async function setAutoHide(checked: boolean) {
      await page.getByRole('button', { name: 'More actions', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
      await settings.getByRole('tab', { name: 'Appearance', exact: true }).click();
      const control = settings.getByRole('switch', { name: 'Auto-hide chat scrollbar', exact: true });
      if ((await control.getAttribute('aria-checked') === 'true') !== checked) await control.click();
      await browserExpect(control).toHaveAttribute('aria-checked', String(checked));
      await settings.getByRole('button', { name: 'Close', exact: true }).click();
      await page.mouse.move(1, 1);
    }

    phase('opting out of the auto-hide default');
    await setAutoHide(false);
    await browserExpect(root).toHaveAttribute('data-chat-scrollbar-auto-hide', 'false');
    await browserExpect(scrollbar).toHaveCSS('opacity', '1');

    phase('enabling auto-hide without remounting or shifting the viewport');
    const originalViewport = await viewport.elementHandle();
    const originalComposer = await composer.elementHandle();
    const geometry = await viewport.boundingBox();
    const composerTop = (await composer.boundingBox())!.y;
    const scrollTop = await viewport.evaluate(element => element.scrollTop);
    await setAutoHide(true);
    await browserExpect(scrollbar).toHaveCSS('opacity', '0');
    await browserExpect(scrollbar).toHaveCSS('pointer-events', 'none');
    expect(await viewport.evaluate((element, original) => element === original, originalViewport)).toBe(true);
    expect(await viewport.boundingBox()).toEqual(geometry);
    expect(await viewport.evaluate(element => element.scrollTop)).toBe(scrollTop);

    phase('revealing on hover, scrolling and keyboard focus');
    await viewport.hover();
    await browserExpect(scrollbar).toHaveCSS('opacity', '1');
    const artifacts = join(import.meta.dirname, '../../artifacts/chromium');
    await mkdir(artifacts, { recursive: true });
    await page.screenshot({ path: join(artifacts, 'chat-scrollbar-hover-desktop.png') });
    await page.mouse.move(1, 1);
    await browserExpect(scrollbar).toHaveCSS('opacity', '0');
    await page.screenshot({ path: join(artifacts, 'chat-scrollbar-hidden-desktop.png') });
    await viewport.evaluate(element => { element.scrollTop -= 100; });
    await browserExpect(scrollbar).toHaveCSS('opacity', '1');
    await browserExpect(scrollbar).toHaveCSS('opacity', '0');
    await page.keyboard.press('Tab');
    await viewport.focus();
    await browserExpect(scrollbar).toHaveAttribute('data-state', 'hidden');
    await browserExpect(scrollbar).toHaveCSS('opacity', '1');
    await page.getByRole('button', { name: 'More actions', exact: true }).focus();
    await browserExpect(scrollbar).toHaveCSS('opacity', '0');

    phase('keeping a captured thumb visible while dragging outside the feed');
    await viewport.hover();
    const thumb = scrollbar.locator('[data-slot="scroll-area-thumb"]');
    const thumbBox = (await thumb.boundingBox())!;
    const beforeDrag = await viewport.evaluate(element => element.scrollTop);
    await page.mouse.move(thumbBox.x + thumbBox.width / 2, thumbBox.y + thumbBox.height / 2);
    await page.mouse.down();
    try {
      await page.mouse.move(geometry!.x - 20, thumbBox.y - 40);
      await browserExpect(scrollbar).toHaveAttribute('data-state', 'hidden');
      await browserExpect(scrollbar).toHaveCSS('opacity', '1');
      expect(await viewport.evaluate(element => element.scrollTop)).not.toBe(beforeDrag);
    } finally {
      await page.mouse.up();
    }
    await page.mouse.move(1, 1);
    await browserExpect(scrollbar).toHaveCSS('opacity', '0');

    phase('retaining composer identity and placement across rapid chat switches');
    for (const index of [1, 0, 1, 0]) {
      await page.locator(`[data-sidebar-virtual-row="${chats[index]}"] button`).first().click();
      await page.waitForURL(`**/chat/${chats[index]}`);
      await browserExpect(root).toHaveAttribute('data-chat-scrollbar-auto-hide', 'true');
      await browserExpect(scrollbar).toHaveCSS('opacity', '0');
      expect(await composer.evaluate((element, original) => element === original, originalComposer)).toBe(true);
      expect((await composer.boundingBox())!.y).toBe(composerTop);
    }
    await page.reload();
    await browserExpect(root).toHaveAttribute('data-chat-scrollbar-auto-hide', 'true');
    await browserExpect(scrollbar).toHaveCSS('opacity', '0');
    await setAutoHide(false);
    await page.reload();
    await browserExpect(root).toHaveAttribute('data-chat-scrollbar-auto-hide', 'false');
    await browserExpect(scrollbar).toHaveCSS('opacity', '1');

    phase('leaving non-overflowing feed content clickable beneath an empty track');
    await setAutoHide(true);
    await page.locator(`[data-sidebar-virtual-row="${chats[2]}"] button`).first().click();
    await page.waitForURL(`**/chat/${chats[2]}`);
    await viewport.hover();
    await browserExpect(scrollbar.locator('[data-scroll-area-thumb]')).toHaveCount(0);
    await browserExpect(scrollbar).toHaveCSS('pointer-events', 'none');
    expect(await scrollbar.evaluate(element => {
      const box = element.getBoundingClientRect();
      return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
        ?.closest('[data-chat-feed-scrollbar]') === null;
    })).toBe(true);

    phase('showing scroll activity on a touch viewport without sticky hover');
    const touchContext = await browser.newContext({
      viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block',
    });
    watchBrowserErrors(touchContext);
    try {
      await authenticateChromiumContext(touchContext, integration);
      const touchPage = await touchContext.newPage();
      await touchPage.goto(`${integration.garcon.baseUrl}/chat/${chats[0]}`);
      const touchViewport = touchPage.locator('[data-chat-scroll-viewport]:visible');
      const touchScrollbar = touchPage.locator('[data-chat-feed-scrollbar]:visible');
      await browserExpect(touchScrollbar).toHaveCSS('opacity', '0');
      expect(await touchPage.evaluate(() => matchMedia('(hover: hover)').matches)).toBe(false);
      await touchPage.screenshot({ path: join(artifacts, 'chat-scrollbar-hidden-touch.png') });
      await browserExpect(touchScrollbar).toHaveCSS('pointer-events', 'none');
      const touchBox = (await touchScrollbar.boundingBox())!;
      const touchX = touchBox.x + touchBox.width / 2;
      const touchY = touchBox.y + touchBox.height / 3;
      expect(await touchPage.evaluate(({ x, y }) =>
        document.elementFromPoint(x, y)?.closest('[data-chat-feed-scrollbar]') === null,
      { x: touchX, y: touchY })).toBe(true);
      const beforeTouch = await touchViewport.evaluate(element => element.scrollTop);
      const protocol = await touchContext.newCDPSession(touchPage);
      await protocol.send('Input.dispatchTouchEvent', {
        type: 'touchStart', touchPoints: [{ id: 1, x: touchX, y: touchY }],
      });
      try {
        for (const offset of [40, 80, 120, 160]) {
          await protocol.send('Input.dispatchTouchEvent', {
            type: 'touchMove', touchPoints: [{ id: 1, x: touchX, y: touchY + offset }],
          });
        }
      } finally {
        await protocol.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await protocol.detach();
      }
      await browserExpect(touchScrollbar).toHaveCSS('opacity', '1');
      expect(await touchViewport.evaluate(element => element.scrollTop)).toBeLessThan(beforeTouch);
      await touchPage.screenshot({ path: join(artifacts, 'chat-scrollbar-scrolling-touch.png') });
      await browserExpect(touchScrollbar).toHaveCSS('opacity', '0');
      const touchViewportBox = (await touchViewport.boundingBox())!;
      await touchPage.touchscreen.tap(
        touchViewportBox.x + touchViewportBox.width / 2,
        touchViewportBox.y + touchViewportBox.height / 2,
      );
      await browserExpect(touchScrollbar).toHaveAttribute('data-state', 'hidden');
      await browserExpect(touchScrollbar).toHaveCSS('opacity', '0');
    } finally {
      await touchContext.close();
    }
  });
}, 120_000);
