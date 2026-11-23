import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import { withChromiumFixture } from '../../support/chromium-fixture.js';

test('Settings blocks the underlying pane without changing body hit testing', async () => {
  await withChromiumFixture('settings-overlay-hit-testing', async ({ page, integration }) => {
    await page.goto(integration.garcon.baseUrl);
    const trigger = page.locator('[data-workspace-window-menu-trigger="window-files"]');
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
    const body = page.locator('body');
    await trigger.focus();
    await trigger.press('Control+,');
    await browserExpect(settings).toBeVisible();
    await browserExpect(body).toHaveCSS('pointer-events', 'auto');
    await browserExpect.poll(() => body.evaluate(el => el.style.overflow)).toBe('hidden');

    await settings.getByRole('tab', { name: 'Appearance', exact: true }).click();
    const font = settings.locator('[aria-labelledby="typography-heading"] button').first();
    await font.click();
    await browserExpect(page.getByRole('dialog')).toHaveCount(2);
    await browserExpect(body).toHaveCSS('pointer-events', 'none');
    await page.keyboard.press('Escape');
    await browserExpect(page.getByRole('dialog')).toHaveCount(1);
    await browserExpect(body).toHaveCSS('pointer-events', 'auto');
    await browserExpect.poll(() => body.evaluate(el => el.style.overflow)).toBe('hidden');
    await page.keyboard.press('Tab');
    expect(await settings.evaluate(el => el.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Escape');
    await browserExpect(settings).toHaveCount(0);
    await browserExpect(trigger).toBeFocused();

    await trigger.press('Control+,');
    await browserExpect(settings).toBeVisible();
    await settings.getByRole('switch', { name: 'Dim and blur behind overlays' }).click();
    await browserExpect(page.locator('[data-slot="dialog-overlay"]')).toHaveCSS('backdrop-filter', 'none');
    const point = await trigger.evaluate(el => {
      const { x, y, width, height } = el.getBoundingClientRect();
      return { x: x + width / 2, y: y + height / 2 };
    });
    expect(await page.evaluate(({ x, y }) =>
      document.elementFromPoint(x, y)?.matches('[data-slot="dialog-overlay"]'), point)).toBe(true);
    await page.mouse.click(point.x, point.y);
    await browserExpect(settings).toHaveCount(0);
    await browserExpect(trigger).toHaveAttribute('aria-expanded', 'false');
    await page.mouse.click(point.x, point.y);
    await browserExpect(trigger).toHaveAttribute('aria-expanded', 'true');
  });
}, 120_000);

test('pane menu blocks outside input without blocking its own scrolling or keyboard navigation', async () => {
  await withChromiumFixture('pane-menu-hit-testing', async ({ page, context, integration }) => {
    const chatId = integration.newChatId();
    const turn = await integration.client.startDirectChat({
      chatId, agent: integration.directAgents.openAi, projectPath: integration.dirs.project,
      content: Array.from({ length: 60 }, (_, i) => `Paragraph ${i}`).join('\n\n'),
    });
    await integration.client.waitForTurnTerminal(chatId, turn.turnId);
    await page.setViewportSize({ width: 1440, height: 480 });
    await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
    const trigger = page.locator('[data-workspace-window-menu-trigger="window-main"]');
    const other = page.locator('[data-workspace-window-menu-trigger="window-files"]');
    const menu = page.locator('[data-workspace-window-menu="window-main"]');
    const chat = page.locator('[data-chat-scroll-viewport]').first();
    await browserExpect.poll(() => chat.evaluate(el => el.scrollTop)).toBeGreaterThan(100);
    const point = await chat.evaluate(el => {
      const { x, y, height } = el.getBoundingClientRect();
      return { x: x + 10, y: y + height / 2 };
    });
    await trigger.press('ArrowDown');
    await browserExpect(menu).toBeVisible();
    await browserExpect(page.locator('body')).toHaveCSS('pointer-events', 'auto');
    await browserExpect(menu.locator('..')).toHaveCSS('position', 'fixed');
    const hit = () => page.evaluate(({ x, y }) =>
      document.elementFromPoint(x, y)?.getAttribute('data-slot'), point);
    await browserExpect.poll(hit).toBe('dropdown-menu-backdrop');
    const atOpen = await chat.evaluate(el => el.scrollTop);
    await page.mouse.move(point.x, point.y);
    await page.mouse.wheel(0, -200);
    await menu.hover();
    await page.mouse.wheel(0, 200);
    await browserExpect.poll(() => menu.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
    expect(await chat.evaluate(el => el.scrollTop)).toBe(atOpen);
    await page.keyboard.press('ArrowDown');
    await browserExpect(menu.locator('[role="menuitem"]:focus')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await browserExpect(menu).toHaveCount(0);
    await browserExpect(trigger).toBeFocused();
    await page.mouse.move(point.x, point.y);
    await page.mouse.wheel(0, -200);
    await browserExpect.poll(() => chat.evaluate(el => el.scrollTop)).toBeLessThan(atOpen);

    const target = await other.evaluate(el => {
      const { x, y, width, height } = el.getBoundingClientRect();
      return { x: x + width / 2, y: y + height / 2 };
    });
    const cdp = await context.newCDPSession(page);
    for (const touch of [false, true]) {
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: touch });
      await trigger.press('Enter');
      await browserExpect(menu).toBeVisible();
      const clickOutside = async () => {
        if (!touch) return page.mouse.click(target.x, target.y);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [target] });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      };
      await clickOutside();
      await browserExpect(menu).toHaveCount(0);
      await browserExpect(other).toHaveAttribute('aria-expanded', 'false');
      await clickOutside();
      await browserExpect(other).toHaveAttribute('aria-expanded', 'true');
      await page.keyboard.press('Escape');
      await browserExpect(other).toHaveAttribute('aria-expanded', 'false');
    }
    await cdp.detach();
  });
}, 120_000);
