import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { withChromiumFixture } from '../../support/chromium-fixture.js';

test('new chat keeps directory input focus after initial prompt focus', async () => {
  await withChromiumFixture('new-chat-focus', async ({ page, context, integration, assertNoBrowserErrors }) => {
    const root = integration.executionDirs.project;
    for (const name of ['alpha', 'beta']) await mkdir(join(root, name));
    await page.goto(integration.garcon.baseUrl);
    await page.clock.install({ time: new Date('2030-01-01T00:00:00Z') });
    await page.clock.pauseAt(new Date('2030-01-01T00:00:10Z'));
    await page.getByRole('button', { name: 'New Chat', exact: true }).first().click();
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
