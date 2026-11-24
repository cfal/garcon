import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { withChromiumFixture } from '../../support/chromium-fixture.js';

test('new chat keeps directory input focus after initial prompt focus', async () => {
  await withChromiumFixture('new-chat-focus', async ({ page, context, integration, assertNoBrowserErrors }) => {
    const root = integration.executionDirs.project;
    for (const name of ['alpha', 'beta']) await mkdir(join(root, name));
    await page.clock.install({ time: new Date('2030-01-01T00:00:00Z') });
    await page.goto(integration.garcon.baseUrl);
    const newChatButton = page.getByRole('button', { name: 'New Chat', exact: true }).first();
    // Keeps startup timers running until authentication and the shell are ready.
    await browserExpect(newChatButton).toBeVisible();
    await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 1_000);
    await newChatButton.click();
    const prompt = page.getByPlaceholder('How can I help you today?');
    const input = page.locator('#project-path-input');
    await browserExpect(prompt).toBeFocused();
    await input.fill(join(root, 'al'));

    // Advances past the former duplicate autofocus while the user edits the path.
    await page.clock.runFor(50);
    await browserExpect(input).toBeFocused();
    await browserExpect(input).toHaveValue(join(root, 'al'));
    await browserExpect(prompt).toHaveValue('');
    await page.clock.resume();
    const browser = page.getByRole('dialog', { name: 'Select Directory', exact: true });
    await browserExpect(browser.getByRole('button', { name: 'alpha', exact: true })).toBeVisible();
    await browserExpect(browser.getByRole('button', { name: 'beta', exact: true })).toHaveCount(0);

    const artifacts = join(import.meta.dirname, '../../artifacts/chromium');
    await mkdir(artifacts, { recursive: true });
    await page.screenshot({ path: join(artifacts, 'new-chat-focus-desktop.png') });
    await input.fill(root);
    await browserExpect(browser.getByRole('button', { name: 'beta', exact: true })).toBeVisible();
    await input.press('Escape');
    await browserExpect(browser).toHaveCount(0);
    await browserExpect(input).toBeFocused();
    await input.click();
    await browserExpect(browser).toHaveCount(0);
    await browserExpect(input).toBeFocused();
    await prompt.click();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await input.click();
    await browserExpect(browser.getByRole('button', { name: 'alpha', exact: true })).toBeVisible();
    await page.screenshot({ path: join(artifacts, 'new-chat-focus-mobile.png') });
    await cdp.detach();
    expect((await integration.client.listChats()).sessions).toEqual([]);
    assertNoBrowserErrors();
  });
}, 120_000);

for (const mobile of [false, true]) {
  test(`committing a ${mobile ? 'touch' : 'desktop'} directory focuses the New Chat prompt before validation`, async () => {
    await withChromiumFixture(`directory-focus-${mobile}`, async ({ page, integration }) => {
      const path = join(integration.executionDirs.project, 'chosen');
      await mkdir(path);
      await page.setViewportSize({ width: mobile ? 390 : 1280, height: 840 });
      await page.goto(integration.garcon.baseUrl);
      await page.getByRole('button', { name: 'New Chat', exact: true }).first().click();
      const input = page.locator('#project-path-input');
      const prompt = page.getByPlaceholder('How can I help you today?');
      const picker = page.getByRole('dialog', { name: 'Select Directory', exact: true });
      await browserExpect(prompt).toBeFocused();
      await input.click();
      if (mobile) {
        await picker.getByRole('button', { name: 'Cancel', exact: true }).click();
        await browserExpect(picker).toHaveCount(0);
        await browserExpect(input).toBeFocused();
        await input.click();
      }
      const validation = Promise.withResolvers<void>();
      await page.route('**/api/v1/chats/validate-start?**', async route => {
        if (new URL(route.request().url()).searchParams.get('path') === path) await validation.promise;
        await route.continue();
      });
      try {
        await picker.getByRole('button', { name: 'chosen', exact: true }).click();
        if (mobile) await picker.getByRole('button', { name: 'Select this directory' }).click();
        else await page.locator('[data-slot="directory-browser-dismiss"]').click({ position: { x: 4, y: 4 } });
        await browserExpect(picker).toHaveCount(0);
        await browserExpect(input).toHaveValue(path);
        await browserExpect(prompt).toBeFocused();
        await page.keyboard.type('Draft while the directory is checked');
        await browserExpect(prompt).toHaveValue('Draft while the directory is checked');
        await browserExpect(page.getByRole('button', { name: 'Start session' })).toBeDisabled();
      } finally {
        validation.resolve();
      }
      await browserExpect(page.getByRole('button', { name: 'Start session' })).toBeEnabled();
      await browserExpect(prompt).toBeFocused();
    });
  }, 120_000);
}
