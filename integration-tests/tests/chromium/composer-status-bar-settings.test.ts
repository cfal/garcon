import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { initializeFixtureRepository } from '../../support/git-fixture.js';

test('Composer status bar categories and included items follow Appearance settings', async () => {
  await withChromiumFixture('composer-status-bar-settings', async ({ page, integration, assertNoBrowserErrors }) => {
    const repository = join(integration.executionDirs.project, 'repository');
    const plainFolder = join(integration.executionDirs.project, 'plain-folder');
    await mkdir(repository);
    await mkdir(plainFolder);
    await initializeFixtureRepository(repository);
    const chats: string[] = [];
    for (const projectPath of [repository, plainFolder]) {
      const chatId = integration.newChatId();
      const started = await integration.client.startDirectChat({
        chatId, content: 'Synthetic bar visibility', projectPath, agent: integration.directAgents.openAi,
      });
      await integration.client.waitForTurnTerminal(chatId, started.turnId);
      chats.push(chatId);
    }
    await page.goto(`${integration.garcon.baseUrl}/chat/${chats[0]}`);
    const pathButton = page.locator('[data-composer-project-path]:visible');
    await browserExpect(pathButton).toHaveAccessibleName(`Change project path: ${repository}`);
    const summaryRead = page.waitForResponse(response =>
      response.url().endsWith('/api/v1/git/quick-summary') &&
      response.request().postDataJSON()?.project === plainFolder);
    await page.locator(`[data-sidebar-virtual-row="${chats[1]}"] button`).first().click();
    expect((await (await summaryRead).json()).status).toBe('not-git-repository');
    await browserExpect(pathButton).toHaveCount(0);
    await browserExpect(page.locator('[data-git-summary-button]:visible')).toHaveCount(0);
    await page.locator(`[data-sidebar-virtual-row="${chats[0]}"] button`).first().click();
    await browserExpect(pathButton).toHaveAccessibleName(`Change project path: ${repository}`);

    const bar = page.locator('[data-composer-status-bar="idle"]:visible');
    const commit = page.locator('[data-git-summary-button]:visible');
    const branch = page.getByRole('button', { name: /current ref/ });
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
    async function setOptions(options: Record<string, boolean>) {
      await page.getByRole('button', { name: 'More actions', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
      await settings.getByRole('tab', { name: 'Appearance', exact: true }).click();
      for (const [name, checked] of Object.entries(options)) {
        const control = settings.getByRole('switch', { name, exact: true });
        if ((await control.getAttribute('aria-checked') === 'true') !== checked) await control.click();
        await browserExpect(control).toHaveAttribute('aria-checked', String(checked));
      }
      await settings.getByRole('button', { name: 'Close', exact: true }).click();
    }

    await setOptions({ 'Show for non-Git projects': true });
    await page.locator(`[data-sidebar-virtual-row="${chats[1]}"] button`).first().click();
    await browserExpect(pathButton).toHaveAccessibleName(`Change project path: ${plainFolder}`);
    await browserExpect(bar).toHaveAttribute('aria-busy', 'false');
    await browserExpect(commit).toHaveCount(0);
    await browserExpect(branch).toHaveCount(0);
    await setOptions({ 'Project path': false });
    await browserExpect(bar).toHaveCount(0);

    await page.locator(`[data-sidebar-virtual-row="${chats[0]}"] button`).first().click();
    await browserExpect(commit).toBeVisible();
    await browserExpect(branch).toBeVisible();
    await setOptions({ 'Git branch': false });
    await browserExpect(branch).toHaveCount(0);
    await browserExpect(commit).toBeVisible();
    await setOptions({ 'Commit button with diff': false });
    await browserExpect(bar).toHaveCount(0);

    // Processing and Stop remain present even with no optional content.
    const held = integration.fakeProviders.openAi.holdNext({ lastUserText: 'Synthetic hidden status bar' });
    let turnId: string | null = null;
    try {
      const started = await integration.client.runDirectChat({
        chatId: chats[0]!, content: 'Synthetic hidden status bar', agent: integration.directAgents.openAi,
      });
      turnId = started.turnId ?? null;
      await held.received;
      await browserExpect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
      await browserExpect(commit).toHaveCount(0);
      await setOptions({ 'Commit button with diff': true });
      await browserExpect(commit).toBeVisible();
      await setOptions({ 'Show for Git projects': false });
      await browserExpect(commit).toHaveCount(0);
      await browserExpect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
    } finally {
      held.releaseEcho();
    }
    if (!turnId) throw new Error('Missing turn ID');
    await integration.client.waitForTurnTerminal(chats[0]!, turnId);
    await browserExpect(bar).toHaveCount(0);

    await setOptions({ 'Project path': true, 'Show for Git projects': true, 'Commit button with diff': false });
    let summaryRequests = 0;
    page.on('request', request => {
      if (request.url().endsWith('/git/quick-summary')) summaryRequests++;
    });
    await page.reload();
    await browserExpect(pathButton).toHaveAccessibleName(`Change project path: ${repository}`);
    await browserExpect(commit).toHaveCount(0);
    await browserExpect(branch).toHaveCount(0);
    await page.waitForLoadState('networkidle');
    expect(summaryRequests).toBe(0);

    const artifacts = join(import.meta.dirname, '../../artifacts/chromium');
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await browserExpect(pathButton.locator('[data-composer-project-path-label]')).toBeVisible();
      expect(await bar.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      await page.screenshot({ path: join(artifacts, `composer-status-bar-path-only-${width}.png`) });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    const panel = page.locator('[data-conversation-panel]:visible');
    await panel.evaluate(element => { element.style.width = '170px'; });
    await browserExpect(pathButton.locator('[data-composer-project-path-label]')).toBeHidden();
    expect((await pathButton.boundingBox())!.width).toBe(32);
    await panel.evaluate(element => { element.style.removeProperty('width'); });
    await setOptions({ 'Show for Git projects': false });
    await browserExpect(bar).toHaveCount(0);
    await page.locator(`[data-sidebar-virtual-row="${chats[1]}"] button`).first().click();
    await browserExpect(pathButton).toHaveAccessibleName(`Change project path: ${plainFolder}`);
    await setOptions({ 'Show for non-Git projects': false });
    await browserExpect(bar).toHaveCount(0);

    await page.getByRole('button', { name: 'More actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
    const section = settings.getByRole('region', { name: 'Composer status bar' });
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await section.scrollIntoViewIfNeeded();
      expect(await section.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      for (const control of await section.getByRole('switch').all()) {
        await browserExpect(control).toBeInViewport();
      }
      await page.screenshot({ path: join(artifacts, `composer-status-bar-settings-${width}.png`) });
    }
    assertNoBrowserErrors();
  });
}, 120_000);
