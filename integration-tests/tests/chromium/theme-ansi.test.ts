import { expect, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect as browserExpect } from 'playwright/test';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { seedLocalSettings } from '../../support/local-settings-seed.js';

const ARTIFACT_DIRECTORY = join(import.meta.dirname, '../../artifacts/chromium');

test.each([1440, 390])(
  'Terminal UI Style opens directly into an interactive workspace at %ipx',
  async (width) => {
    await withChromiumFixture(
      `terminal immediate workspace ${width}`,
      async ({ page, context, integration, assertNoBrowserErrors }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        await page.addInitScript(seedLocalSettings, {
          terminalAppearance: true,
          reduceMotion: false,
        });
        const start = Date.now();
        await page.clock.install({ time: start });
        await page.clock.pauseAt(start + 1000);
        const protocol = await context.newCDPSession(page);
        try {
          await protocol.send('Emulation.setTouchEmulationEnabled', {
            enabled: width === 390,
          });
          await page.goto(integration.garcon.baseUrl);
          await browserExpect(
            page.locator('[data-workspace-content]'),
          ).toBeVisible();
          await browserExpect(page.locator('html')).toHaveAttribute(
            'data-theme-appearance',
            'terminal',
          );
          await browserExpect(page.locator('[data-ansi-startup]')).toHaveCount(0);
          await page.clock.resume();
          const newChat = page
            .getByRole('button', { name: 'New Chat', exact: true })
            .first();
          if (width === 390) {
            const bounds = (await newChat.boundingBox())!;
            await protocol.send('Input.dispatchTouchEvent', {
              type: 'touchStart',
              touchPoints: [
                {
                  x: bounds.x + bounds.width / 2,
                  y: bounds.y + bounds.height / 2,
                  id: 1,
                },
              ],
            });
            await protocol.send('Input.dispatchTouchEvent', {
              type: 'touchEnd',
              touchPoints: [],
            });
          } else {
            await newChat.click();
          }
          const dialog = page.getByRole('dialog');
          await browserExpect(dialog).toBeVisible();
          const prompt = dialog.getByPlaceholder('How can I help you today?');
          await prompt.fill('Synthetic immediate input');
          await browserExpect(prompt).toHaveValue('Synthetic immediate input');
          assertNoBrowserErrors();
        } finally {
          await protocol.detach();
        }
      },
    );
  },
  60_000,
);

test('ANSI workspace keeps drafts and composer geometry through chat switches', async () => {
  await withChromiumFixture(
    'ANSI chat switches',
    async ({ page, integration, assertNoBrowserErrors }) => {
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
      await page.addInitScript(seedLocalSettings, {
        themePreference: { mode: 'fixed', themeId: 'ansi-dark' },
        terminalAppearance: true,
      });
      await page.goto(`${integration.garcon.baseUrl}/chat/${ids[0]}`);
      await browserExpect(page.getByText('GARCON://', { exact: true })).toHaveCount(0);
      await page.evaluate(() => document.fonts.ready);
      const composer = page.locator('[data-composer]');
      const editor = composer.locator('textarea');
      const owner = page.locator('[data-conversation-panel-composer-anchor="true"]');
      const draft = 'Synthetic retained ANSI draft';
      await editor.fill(draft);
      await editor.evaluate((element) => element.setAttribute('data-retained-editor', 'true'));
      const before = await composer.boundingBox();
      expect(await page.locator('[data-workspace-window-id]').count()).toBeGreaterThanOrEqual(2);
      await browserExpect(
        page.locator('[data-workspace-window-fullscreen] > svg').first(),
      ).toBeVisible();
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
      }
      await mkdir(ARTIFACT_DIRECTORY, { recursive: true });
      for (const width of [1440, 390, 360, 320]) {
        await page.setViewportSize({ width, height: 900 });
        await browserExpect(
          page
            .getByRole('region', { name: 'Chat messages', exact: true })
            .getByText('Synthetic ANSI workspace sample 1', { exact: true }),
        ).toBeVisible();
        await page.screenshot({ path: join(ARTIFACT_DIRECTORY, `ansi-workspace-${width}.png`) });
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
    const appearance = page.getByRole('combobox', {
      name: 'UI Style',
      exact: true,
    });
    const font = page.getByRole('button', { name: /^Interface Font:/ });
    const mono = page.getByRole('button', {
      name: /^Chat Code & Commands Font:/,
    });
    async function chooseFont(button: typeof font, value: string) {
      await button.click();
      const picker = page.getByRole('dialog', { name: / Font$/ });
      await picker.locator(`input[type="radio"][value="${value}"]`).check();
      await picker.getByRole('button', { name: 'Apply', exact: true }).click();
      await browserExpect(picker).toHaveCount(0);
    }
    await browserExpect(appearance).toHaveValue('default');
    const originalPalette = await select.inputValue();
    await appearance.selectOption('terminal');
    expect(await select.inputValue()).toBe(originalPalette);
    expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toBe(
      originalFont,
    );
    await browserExpect(font).toContainText('System UI');
    await browserExpect(mono).toContainText('System monospace');
    await chooseFont(font, 'departure-mono');
    await chooseFont(mono, 'departure-mono');
    await mkdir(ARTIFACT_DIRECTORY, { recursive: true });

    for (const id of ['ansi-dark', 'ansi-light']) {
      await select.selectOption(id);
      await page.evaluate(() => document.fonts.ready);
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
      for (const width of [1440, 390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        await mono.scrollIntoViewIfNeeded();
        for (const control of [font, mono]) {
          expect(await control.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
        }
        const fits = await appearance.evaluate((element: HTMLSelectElement) => {
          const styles = getComputedStyle(element);
          const canvas = document.createElement('canvas');
          const context = canvas.getContext('2d')!;
          context.font = `${styles.fontWeight} ${styles.fontSize} ${styles.fontFamily}`;
          return (
            context.measureText(element.selectedOptions[0].text).width <=
            element.clientWidth - parseFloat(styles.paddingLeft) - parseFloat(styles.paddingRight)
          );
        });
        expect(fits).toBe(true);
        await page.screenshot({ path: join(ARTIFACT_DIRECTORY, `${id}-${width}.png`) });
        const box = await dialog.boundingBox();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(width);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      }
    }
    await select.selectOption('phosphor-light');
    await browserExpect(dialog).toHaveCSS('border-top-style', 'double');
    await appearance.selectOption('default');
    expect(await select.inputValue()).toBe('phosphor-light');
    await browserExpect(dialog).toHaveCSS('border-radius', originalRadius);
    expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toContain(
      'Departure Mono',
    );
    await chooseFont(font, 'default');
    expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toBe(
      originalFont,
    );
    await browserExpect(dialog).toHaveCSS('border-top-style', 'solid');
    await select.selectOption('ansi-dark');
    await browserExpect(dialog).toHaveCSS('border-top-style', 'solid');
    await appearance.selectOption('terminal');
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
    await newChat.screenshot({ path: join(ARTIFACT_DIRECTORY, 'ansi-dialog-scrolled.png') });
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
    const panel = page.locator('[data-workspace-chat-list-panel]');
    await browserExpect(panel).toHaveAttribute('data-divider-edge', 'start');
    await browserExpect(panel).toHaveCSS('border-inline-start-style', 'double');
    await browserExpect(panel).toHaveCSS('border-inline-end-width', '0px');
    await browserExpect(page.locator('html')).toHaveAttribute('data-theme-appearance', 'terminal');
    await browserExpect(page.locator('html')).toHaveAttribute('data-theme', 'ansi-dark');
    assertNoBrowserErrors();
  });
}, 60_000);
