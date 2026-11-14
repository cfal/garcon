import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { withChromiumFixture } from '../../support/chromium-fixture.js';

test('New Chat project browsing keeps its draft and returns focus to Choose folder', async () => {
  await withChromiumFixture('new-chat-focus', async ({ page, context, integration, assertNoBrowserErrors }, phase) => {
    const root = integration.executionDirs.project;
    await mkdir(join(root, 'alpha', 'nested'), { recursive: true });
    await mkdir(join(root, 'beta'), { recursive: true });
    await integration.client.put('/api/v1/app/settings', {
      paths: { pinnedProjectPaths: [root], recentProjectPaths: [root] },
    });
    await page.goto(integration.garcon.baseUrl);
    const newChatButton = page.getByRole('button', { name: 'New Chat', exact: true }).first();
    await browserExpect(newChatButton).toBeVisible();
    await browserExpect(page.getByRole('dialog', { name: 'New Chat', exact: true })).toBeVisible();

    const newChat = page.getByRole('dialog', { name: 'New Chat', exact: true });
    const prompt = newChat.getByPlaceholder('How can I help you today?');
    await browserExpect(prompt).toBeFocused();
    const project = newChat.getByRole('region', { name: 'Saved and recent projects', exact: true })
      .getByRole('button', { name: root, exact: true });
    await project.click();
    await browserExpect(project).toHaveAttribute('aria-pressed', 'true');
    const draft = 'Synthetic project picker draft';
    await prompt.fill(draft);
    const chooseProject = newChat.getByRole('button', { name: 'Choose folder', exact: true });
    const browser = page.getByRole('dialog', { name: 'Select Directory', exact: true });
    const artifacts = join(import.meta.dirname, '../../artifacts/chromium');
    await mkdir(artifacts, { recursive: true });

    phase('desktop directory browsing and keyboard navigation');
    await page.setViewportSize({ width: 1440, height: 900 });
    await chooseProject.click();
    await browserExpect(browser).toBeVisible();
    const alpha = browser.getByRole('button', { name: 'alpha', exact: true });
    await browserExpect(alpha).toBeVisible();
    await browserExpect(browser.getByRole('button', { name: 'beta', exact: true })).toBeVisible();
    await alpha.focus();
    await browserExpect(alpha).toBeFocused();
    await page.screenshot({ path: join(artifacts, 'new-chat-focus-desktop.png') });
    await page.keyboard.press('Enter');
    await browserExpect(browser.getByRole('button', { name: 'nested', exact: true })).toBeVisible();
    await browserExpect(browser).toBeVisible();
    await page.keyboard.press('Escape');
    await browserExpect(browser).toHaveCount(0);
    await browserExpect(chooseProject).toBeFocused();
    await browserExpect(prompt).toHaveValue(draft);

    phase('mobile directory filter and Escape focus restoration');
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await chooseProject.click();
    await browserExpect(browser).toBeVisible();
    const filter = browser.getByRole('textbox', { name: 'Filter directories...', exact: true });
    await filter.click();
    await browserExpect(filter).toBeFocused();
    await page.screenshot({ path: join(artifacts, 'new-chat-focus-mobile.png') });
    await page.keyboard.press('Escape');
    await browserExpect(browser).toHaveCount(0);
    await browserExpect(chooseProject).toBeFocused();
    await browserExpect(prompt).toHaveValue(draft);
    await cdp.detach();

    expect((await integration.client.listChats()).sessions).toEqual([]);
    assertNoBrowserErrors();
  });
}, 120_000);
