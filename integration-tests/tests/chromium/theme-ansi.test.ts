import { expect, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { expect as browserExpect } from 'playwright/test';
import type { Page } from 'playwright';
import { withChromiumFixture } from '../../support/chromium-fixture.js';

async function recordStartupMounts(page: Page) {
  await page.addInitScript(() => {
    let count = 0;
    Object.defineProperty(window, '__startupMounts', { get: () => count });
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          if (node.matches('[data-ansi-startup]') || node.querySelector('[data-ansi-startup]')) {
            count++;
          }
        }
      }
    }).observe(document, { childList: true, subtree: true });
  });
}

async function startupMounts(page: Page) {
  return page.evaluate(
    () => (window as typeof window & { __startupMounts: number }).__startupMounts,
  );
}

test('ANSI startup paints moving ASCII, expires, and respects interaction and motion preferences', async () => {
  await withChromiumFixture(
    'ANSI startup',
    async ({ page, integration, assertNoBrowserErrors }) => {
      await recordStartupMounts(page);
      await page.addInitScript(() => {
        const key = 'pref_local_settings';
        const settings = JSON.parse(localStorage.getItem(key) ?? '{}');
        settings.terminalAppearance = true;
        if (!settings.themePreference) {
          settings.themePreference = { mode: 'fixed', themeId: 'ansi-dark' };
          localStorage.setItem(key, JSON.stringify(settings));
        }
      });
      await page.goto(integration.garcon.baseUrl, { waitUntil: 'domcontentloaded' });
      const canvas = page.locator('[data-ansi-startup] canvas');
      await browserExpect(canvas).toBeVisible();
      const fingerprint = await canvas.evaluate((element: HTMLCanvasElement) => {
        const pixels = element
          .getContext('2d')!
          .getImageData(0, 0, element.width, element.height).data;
        return pixels.reduce((sum, value) => sum + value, 0);
      });
      await page.waitForFunction((before) => {
        const element = document.querySelector<HTMLCanvasElement>('[data-ansi-startup] canvas');
        if (!element) return false;
        const pixels = element
          .getContext('2d')!
          .getImageData(0, 0, element.width, element.height).data;
        return pixels.reduce((sum, value) => sum + value, 0) !== before;
      }, fingerprint);
      const dimensions = await canvas.evaluate((element: HTMLCanvasElement) => ({
        width: element.width,
        height: element.height,
        focused: document.activeElement === element,
        inert: document.body.inert,
      }));
      expect(dimensions.width).toBeLessThanOrEqual(840);
      expect(dimensions.height).toBeLessThanOrEqual(495);
      expect(dimensions.focused).toBe(false);
      expect(dimensions.inert).toBe(false);
      await mkdir('artifacts/chromium', { recursive: true });
      await page.screenshot({ path: 'artifacts/chromium/ansi-startup-desktop.png' });
      await browserExpect(canvas).toHaveCount(0, { timeout: 5000 });
      await browserExpect(page.locator('[data-workspace-content]')).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      expect(await page.evaluate(() => document.fonts.check('11px "Departure Mono"'))).toBe(true);

      await page.setViewportSize({ width: 390, height: 844 });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await browserExpect(canvas).toBeVisible();
      await page.screenshot({ path: 'artifacts/chromium/ansi-startup-mobile.png' });
      await browserExpect(page.locator('[data-workspace-content]')).toBeVisible();
      expect(await page.evaluate(() => performance.now())).toBeLessThan(2300);
      await page.keyboard.press('Shift');
      await browserExpect(canvas).toHaveCount(0, { timeout: 300 });

      await page.reload({ waitUntil: 'domcontentloaded' });
      await browserExpect(canvas).toBeVisible();
      await page.evaluate(() => {
        const target = document.createElement('button');
        target.style.cssText = 'position:fixed;inset:0;z-index:99';
        target.dataset.clickThrough = 'false';
        target.onclick = () => {
          target.dataset.clickThrough = 'true';
        };
        document.body.append(target);
      });
      expect(await page.evaluate(() => performance.now())).toBeLessThan(2300);
      await page.mouse.click(2, 2);
      await browserExpect(canvas).toHaveCount(0, { timeout: 300 });
      await browserExpect(page.locator('[data-click-through]')).toHaveAttribute(
        'data-click-through',
        'false',
      );

      await page.emulateMedia({ forcedColors: 'active' });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await browserExpect(page.locator('[data-workspace-content]')).toBeVisible();
      await browserExpect(canvas).toHaveCount(0);
      await page.emulateMedia({ forcedColors: 'none' });
      expect(await startupMounts(page)).toBe(0);

      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await browserExpect(page.locator('[data-workspace-content]')).toBeVisible();
      await browserExpect(canvas).toHaveCount(0);

      await page.emulateMedia({ reducedMotion: 'no-preference' });
      expect(await startupMounts(page)).toBe(0);
      await page.evaluate(() => {
        const settings = JSON.parse(localStorage.getItem('pref_local_settings')!);
        settings.reduceMotion = true;
        localStorage.setItem('pref_local_settings', JSON.stringify(settings));
      });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await browserExpect(page.locator('[data-workspace-content]')).toBeVisible();
      await browserExpect(canvas).toHaveCount(0);
      expect(await startupMounts(page)).toBe(0);
      assertNoBrowserErrors();
    },
  );
}, 60_000);

test('startup consumes double-click presses over menus without losing composer focus', async () => {
  await withChromiumFixture(
    'ANSI startup pointer gestures',
    async ({ page, integration, assertNoBrowserErrors }) => {
      const chatId = integration.newChatId();
      const started = await integration.client.startDirectChat({
        chatId,
        content: 'Synthetic startup focus sample',
        projectPath: integration.dirs.project,
        agent: integration.directAgents.openAi,
      });
      await integration.client.waitForTurnTerminal(chatId, started.turnId);
      await page.addInitScript(() => {
        const settings = JSON.parse(localStorage.getItem('pref_local_settings') ?? '{}');
        localStorage.setItem(
          'pref_local_settings',
          JSON.stringify({ ...settings, terminalAppearance: true }),
        );
      });
      await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`, {
        waitUntil: 'domcontentloaded',
      });
      const splash = page.locator('[data-ansi-startup]');
      await browserExpect(splash).toBeVisible();
      const editor = page.locator('[data-composer] textarea');
      await editor.evaluate((element) => element.focus());
      const trigger = page.locator(
        '[data-slot="sidebar-controls-row"] [data-slot="dropdown-menu-trigger"]',
      );
      await browserExpect(trigger).toBeVisible();
      const bounds = await trigger.boundingBox();
      expect(bounds).not.toBeNull();
      expect(await page.evaluate(() => performance.now())).toBeLessThan(2300);
      await page.mouse.dblclick(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2, {
        delay: 60,
      });
      await browserExpect(splash).toHaveCount(0, { timeout: 300 });
      await browserExpect(trigger).toHaveAttribute('aria-expanded', 'false');
      await browserExpect(editor).toBeFocused();
      await page.reload({ waitUntil: 'domcontentloaded' });
      await browserExpect(splash).toBeVisible();
      const newChat = page
        .locator('[data-slot="sidebar-controls-row"]')
        .getByRole('button', { name: 'New Chat', exact: true });
      const actionBounds = (await newChat.boundingBox())!;
      const x = actionBounds.x + actionBounds.width / 2;
      const y = actionBounds.y + actionBounds.height / 2;
      expect(await page.evaluate(() => performance.now())).toBeLessThan(2300);
      await page.mouse.click(x, y);
      await browserExpect(splash).toHaveCount(0, { timeout: 300 });
      await page.mouse.down({ clickCount: 2 });
      await page.mouse.move(x + 10, y);
      await page.mouse.up({ clickCount: 2 });
      await browserExpect(page.getByRole('dialog')).toHaveCount(0);
      await newChat.click({ position: { x: 8, y: 18 } });
      await browserExpect(
        page.getByRole('dialog').getByRole('textbox', { name: 'Project Path', exact: true }),
      ).toBeVisible();

      assertNoBrowserErrors();
    },
  );
}, 60_000);

test('startup consumes complete taps, swipes and double taps over mobile menus', async () => {
  await withChromiumFixture(
    'ANSI startup touch gestures',
    async ({ page, context, integration, assertNoBrowserErrors }) => {
      await page.addInitScript(() => {
        const settings = JSON.parse(localStorage.getItem('pref_local_settings') ?? '{}');
        localStorage.setItem(
          'pref_local_settings',
          JSON.stringify({ ...settings, terminalAppearance: true }),
        );
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.clock.install();
      const protocol = await context.newCDPSession(page);
      try {
        await protocol.send('Emulation.setTouchEmulationEnabled', {
          enabled: true,
          maxTouchPoints: 2,
        });
        for (const gesture of [
          'tap',
          'swipe',
          'double-tap',
          'slow-repeat',
          'deadline',
          'multi-touch',
        ]) {
          await page.goto(integration.garcon.baseUrl, { waitUntil: 'domcontentloaded' });
          const splash = page.locator('[data-ansi-startup]');
          await browserExpect(splash).toBeVisible();
          await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000);
          await browserExpect(splash).toBeVisible();
          const trigger = page.locator(
            '[data-slot="dropdown-menu-trigger"][aria-label="Settings"]:visible',
          );
          const bounds = await trigger.boundingBox();
          expect(bounds).not.toBeNull();
          const point = {
            x: bounds!.x + bounds!.width / 2,
            y: bounds!.y + bounds!.height / 2,
            id: 1,
          };
          const swipeOffset = point.y < 422 ? 100 : -100;
          const start = gesture === 'swipe' ? { ...point, y: point.y + swipeOffset } : point;
          expect(start.y, gesture).toBeGreaterThan(0);
          expect(start.y, gesture).toBeLessThan(844);
          await protocol.send('Input.dispatchTouchEvent', {
            type: 'touchStart',
            touchPoints: [start],
          });
          if (gesture === 'swipe') {
            await protocol.send('Input.dispatchTouchEvent', {
              type: 'touchMove',
              touchPoints: [point],
            });
          }
          if (gesture === 'deadline') {
            await page.clock.runFor(2600);
            await browserExpect(splash).toBeVisible();
          }
          if (gesture === 'multi-touch') {
            await protocol.send('Input.dispatchTouchEvent', {
              type: 'touchStart',
              touchPoints: [point, { ...point, x: point.x - 60, id: 2 }],
            });
            await protocol.send('Input.dispatchTouchEvent', {
              type: 'touchEnd',
              touchPoints: [point],
            });
            await browserExpect(splash).toBeVisible();
          }
          await protocol.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
          await browserExpect(splash, gesture).toHaveCount(0, { timeout: 300 });
          if (gesture === 'double-tap' || gesture === 'slow-repeat') {
            if (gesture === 'slow-repeat') await page.clock.runFor(330);
            await protocol.send('Input.dispatchTouchEvent', {
              type: 'touchStart',
              touchPoints: [{ ...point, x: point.x + 10, y: point.y + 10 }],
            });
            if (gesture === 'slow-repeat') await page.clock.runFor(300);
            await protocol.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
          }
          await browserExpect(trigger).toHaveAttribute('aria-expanded', 'false');
          await page.clock.resume();
        }
      } finally {
        await protocol.detach();
      }
      assertNoBrowserErrors();
    },
  );
}, 60_000);

test('ANSI workspace keeps drafts and composer geometry through chat switches', async () => {
  await withChromiumFixture(
    'ANSI chat switches',
    async ({ page, integration, assertNoBrowserErrors }) => {
      await recordStartupMounts(page);
      const ids = [integration.newChatId(), integration.newChatId()];
      for (const [index, chatId] of ids.entries()) {
        const started = await integration.client.startDirectChat({
          chatId,
          content: `Synthetic ANSI workspace sample ${index + 1}`,
          projectPath: integration.dirs.project,
          agent: integration.directAgents.openAi,
        });
        await integration.client.waitForTurnTerminal(chatId, started.turnId);
        await integration.client.waitForProcessing(chatId, false);
      }
      await page.addInitScript(() => {
        const settings = JSON.parse(localStorage.getItem('pref_local_settings') ?? '{}');
        localStorage.setItem(
          'pref_local_settings',
          JSON.stringify({
            ...settings,
            themePreference: { mode: 'fixed', themeId: 'ansi-dark' },
            terminalAppearance: true,
          }),
        );
      });
      await page.goto(`${integration.garcon.baseUrl}/chat/${ids[0]}`);
      await browserExpect(page.locator('[data-ansi-startup]')).toBeVisible();
      await browserExpect(page.locator('[data-ansi-startup]')).toHaveCount(0);
      expect(await startupMounts(page)).toBe(1);
      await page.evaluate(() => document.fonts.ready);
      const composer = page.locator('[data-composer]');
      const editor = composer.locator('textarea');
      const owner = page.locator('[data-conversation-panel-composer-anchor="true"]');
      const draft = 'Synthetic retained ANSI draft';
      await editor.fill(draft);
      await editor.evaluate((element) => element.setAttribute('data-retained-editor', 'true'));
      const before = await composer.boundingBox();
      expect(await page.locator('[data-workspace-window-id]').count()).toBeGreaterThanOrEqual(2);
      const chatBody = await page.locator('[data-workspace-live-chat-body]').boundingBox();
      const titlebar = await page
        .locator('[data-workspace-window-current="true"] [data-workspace-window-titlebar]')
        .boundingBox();
      expect(chatBody!.y).toBeGreaterThanOrEqual(titlebar!.y + titlebar!.height);
      for (const chatId of [ids[1], ids[0], ids[1], ids[0]]) {
        await page.locator(`[data-sidebar-virtual-row="${chatId}"]`).click();
        await browserExpect(owner).toHaveAttribute('data-conversation-panel-chat-id', chatId);
        await browserExpect(editor).toHaveValue(chatId === ids[0] ? draft : '');
        await browserExpect(editor).toHaveAttribute('data-retained-editor', 'true');
        expect((await composer.boundingBox())!.y).toBe(before!.y);
        await browserExpect(page.locator('[data-ansi-startup]')).toHaveCount(0);
        expect(await startupMounts(page)).toBe(1);
      }
      await mkdir('artifacts/chromium', { recursive: true });
      for (const width of [1440, 390, 360, 320]) {
        await page.setViewportSize({ width, height: 900 });
        await browserExpect(
          page
            .getByRole('region', { name: 'Chat messages', exact: true })
            .getByText('Synthetic ANSI workspace sample 1', { exact: true }),
        ).toBeVisible();
        await page.screenshot({ path: `artifacts/chromium/ansi-workspace-${width}.png` });
        const box = (await composer.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
        expect(
          await editor.evaluate((element) => parseFloat(getComputedStyle(element).fontSize)),
        ).toBeGreaterThanOrEqual(16);
      }
      assertNoBrowserErrors();
    },
  );
}, 60_000);

test('ANSI chrome stays usable on desktop and mobile, and leaves other themes unchanged', async () => {
  await withChromiumFixture('ANSI chrome', async ({ page, integration, assertNoBrowserErrors }) => {
    await page.goto(integration.garcon.baseUrl);
    await page.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
    await browserExpect(dialog).toBeVisible();
    await page.getByRole('radio', { name: 'Use one theme' }).click();
    const select = page.getByRole('combobox', { name: 'Theme', exact: true });
    const originalRadius = await dialog.evaluate(
      (element) => getComputedStyle(element).borderRadius,
    );
    const originalFont = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
    const appearance = page.getByRole('checkbox', { name: 'Terminal appearance', exact: true });
    await browserExpect(appearance).not.toBeChecked();
    const originalPalette = await select.inputValue();
    await appearance.check();
    expect(await select.inputValue()).toBe(originalPalette);
    await mkdir('artifacts/chromium', { recursive: true });

    for (const id of ['ansi-dark', 'ansi-light']) {
      await select.selectOption(id);
      await page.evaluate(() => document.fonts.ready);
      await browserExpect(page.locator('[data-ansi-startup]')).toHaveCount(0);
      await browserExpect(dialog).toHaveCSS('border-radius', '0px');
      await browserExpect(dialog).toHaveCSS('border-top-style', 'double');
      await browserExpect(dialog).toHaveCSS(
        'background-color',
        id === 'ansi-dark' ? 'rgb(23, 23, 23)' : 'rgb(247, 247, 247)',
      );
      expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toContain(
        'Departure Mono',
      );
      await select.focus();
      await browserExpect(select).toBeFocused();
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await page.screenshot({ path: `artifacts/chromium/${id}-${width}.png` });
        const box = await dialog.boundingBox();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(width);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      }
    }
    await select.selectOption('phosphor-light');
    await browserExpect(dialog).toHaveCSS('border-top-style', 'double');
    await appearance.uncheck();
    expect(await select.inputValue()).toBe('phosphor-light');
    await browserExpect(dialog).toHaveCSS('border-radius', originalRadius);
    expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toBe(
      originalFont,
    );
    await browserExpect(dialog).toHaveCSS('border-top-style', 'solid');
    await select.selectOption('ansi-dark');
    await browserExpect(dialog).toHaveCSS('border-top-style', 'solid');
    await appearance.check();
    await browserExpect(dialog).toHaveCSS('border-top-style', 'double');
    await page.keyboard.press('Escape');
    await browserExpect(dialog).toHaveCount(0);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole('button', { name: 'New Chat', exact: true }).first().click();
    const newChat = page.getByRole('dialog');
    await page
      .getByRole('status', { name: 'Loading chat defaults...' })
      .waitFor({ state: 'detached' });
    await page
      .getByPlaceholder('How can I help you today?')
      .fill('Synthetic multiline prompt\n'.repeat(20));
    await page.setViewportSize({ width: 390, height: 420 });
    await browserExpect(newChat).toHaveCSS('border-top-style', 'double');
    await browserExpect
      .poll(() => newChat.evaluate((element) => element.scrollHeight > element.clientHeight))
      .toBe(true);
    const scroll = await newChat.evaluate((element) => {
      const before = element.getBoundingClientRect().toJSON();
      element.scrollTop = element.scrollHeight;
      return {
        before,
        after: element.getBoundingClientRect().toJSON(),
        top: element.scrollTop,
        fits: element.scrollWidth <= element.clientWidth,
      };
    });
    expect(scroll.top).toBeGreaterThan(0);
    expect(scroll.fits).toBe(true);
    expect(scroll.after).toEqual(scroll.before);
    await browserExpect(newChat).toHaveCSS('border-bottom-style', 'double');
    await newChat.screenshot({ path: 'artifacts/chromium/ansi-dialog-scrolled.png' });
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => {
      const settings = JSON.parse(localStorage.getItem('pref_local_settings')!);
      localStorage.setItem(
        'pref_local_settings',
        JSON.stringify({ ...settings, chatListDock: 'right' }),
      );
    });
    await page.reload();
    await browserExpect(page.locator('[data-ansi-startup]')).toHaveCount(0);
    const panel = page.locator('[data-workspace-chat-list-panel]');
    await browserExpect(panel).toHaveAttribute('data-divider-edge', 'start');
    await browserExpect(panel).toHaveCSS('border-inline-start-style', 'double');
    await browserExpect(panel).toHaveCSS('border-inline-end-width', '0px');
    await browserExpect(page.locator('html')).toHaveAttribute('data-theme-appearance', 'terminal');
    await browserExpect(page.locator('html')).toHaveAttribute('data-theme', 'ansi-dark');
    assertNoBrowserErrors();
  });
}, 60_000);

test('terminal startup never covers public login or shared pages', async () => {
  await withChromiumFixture('terminal public routes', async ({ browser, integration }) => {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    try {
      const page = await context.newPage();
      await recordStartupMounts(page);
      await page.addInitScript(() =>
        localStorage.setItem('pref_local_settings', JSON.stringify({ terminalAppearance: true })),
      );
      for (const path of ['/login', '/shared/synthetic-missing-share']) {
        await page.goto(`${integration.garcon.baseUrl}${path}`);
        await browserExpect(page.locator('html')).toHaveAttribute(
          'data-theme-appearance',
          'terminal',
        );
        await page.keyboard.press('Shift');
        expect(await startupMounts(page)).toBe(0);
        await browserExpect(page.locator('[data-ansi-startup]')).toHaveCount(0, { timeout: 300 });
      }
    } finally {
      await context.close();
    }
  });
}, 60_000);
