import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { Deferred, withTimeout } from '../../support/deferred.js';
import { initializeFixtureRepository, runFixtureGit } from '../../support/git-fixture.js';

test('Git tray survives slow reads and keeps its shared action aligned across chat states', async () => {
  await withChromiumFixture('git-summary-tray', async ({ page, integration, assertNoBrowserErrors }, markPhase) => {
    const project = integration.executionDirs.project;
    await initializeFixtureRepository(project);
    await runFixtureGit(project, 'branch', '-m', 'fix/git-summary-mobile-and-desktop-alignment');
    await mkdir(join(project, 'artifacts/nested'), { recursive: true });
    await writeFile(join(project, 'artifacts/nested/new.txt'), 'new\n');
    const chats: string[] = [];
    for (const content of ['git-tray-first', 'git-tray-second']) {
      const chatId = integration.newChatId();
      const started = await integration.client.startDirectChat({
        chatId, content, projectPath: project, agent: integration.directAgents.openAi,
      });
      await integration.client.waitForTurnTerminal(chatId, started.turnId);
      chats.push(chatId);
    }

    const received = new Deferred<void>();
    const release = new Deferred<void>();
    let requests = 0;
    let stopRequests = 0;
    page.on('request', request => {
      if (request.url().endsWith('/chats/stop')) stopRequests++;
    });
    const failedRequests: string[] = [];
    page.on('requestfailed', request => {
      if (request.url().endsWith('/git/quick-summary')) failedRequests.push(request.failure()?.errorText ?? 'failed');
    });
    await page.route('**/api/v1/git/quick-summary', async route => {
      requests++;
      received.resolve();
      await release.promise;
      await route.continue();
    });
    await page.clock.install();
    await page.goto(`${integration.garcon.baseUrl}/chat/${chats[0]}`);
    const gitButton = page.locator('[data-git-summary-button] button:visible');
    const composer = page.locator('[data-composer]:visible');
    await gitButton.waitFor();
    try {
      markPhase('holding the initial summary beyond the idle polling interval');
      await withTimeout(received.promise, 10_000, () => 'Summary request not received');
      await page.clock.runFor(16_000);
      expect(requests).toBe(1);
      expect(failedRequests).toEqual([]);
    } finally {
      release.resolve();
      await page.clock.resume();
    }
    await browserExpect(gitButton).toHaveAccessibleName('Commit New files');
    await page.unroute('**/api/v1/git/quick-summary');
    const composerElement = await composer.elementHandle();
    const initialBox = await composer.boundingBox();

    markPhase('rapidly switching chats without replacing or moving the composer');
    for (const id of [chats[1], chats[0], chats[1], chats[0]]) {
      await page.locator(`[data-sidebar-virtual-row="${id}"] button`).first().click();
      await page.waitForURL(`**/chat/${id}`);
      await browserExpect(gitButton).toHaveAccessibleName('Commit New files');
      expect(await composer.evaluate((element, original) => element === original, composerElement)).toBe(true);
      expect((await composer.boundingBox())?.y).toBe(initialBox?.y);
    }

    await writeFile(join(project, 'example.txt'), 'changed\n'.repeat(42));
    await page.clock.runFor(15_000);
    const statsLabel = /Commit.*\+42.*-1/;
    await browserExpect(gitButton).toHaveAccessibleName(statsLabel);

    for (const width of [1440, 375]) {
      markPhase(`checking idle and running button geometry at ${width}px`);
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const idleBox = await composer.boundingBox();
      const buttonBox = await gitButton.boundingBox();
      if (!idleBox || !buttonBox) throw new Error('Missing idle geometry');
      const inset = idleBox.x + idleBox.width - buttonBox.x - buttonBox.width;
      expect(inset).toBeGreaterThan(10);
      expect(inset).toBeLessThan(19);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      const idleScreenshot = join(integration.dirs.root, `git-tray-idle-${width}.png`);
      await page.screenshot({ path: idleScreenshot });
      console.log(`Git tray screenshot: ${idleScreenshot}`);
      const input = composer.locator('textarea');
      await input.fill('Retained draft');
      const held = integration.fakeProviders.openAi.holdNext({ lastUserText: `git-tray-held-${width}` });
      let turnId: string | null = null;
      try {
        const started = await integration.client.runDirectChat({
          chatId: chats[0]!, content: `git-tray-held-${width}`, agent: integration.directAgents.openAi,
        });
        turnId = started.turnId ?? null;
        await withTimeout(held.received, 10_000, () => 'Held turn not received');
        const stop = page.getByRole('button', { name: 'Stop', exact: true });
        await stop.waitFor();
        await browserExpect(gitButton).toHaveAccessibleName(statsLabel);
        const runningGit = await gitButton.boundingBox();
        const stopBox = await stop.boundingBox();
        if (!runningGit || !stopBox) throw new Error('Missing running geometry');
        expect(runningGit.x + runningGit.width).toBeLessThan(stopBox.x);
        expect((await composer.boundingBox())?.y).toBe(idleBox.y);
        await browserExpect(input).toBeFocused();
        await browserExpect(input).toHaveValue('Retained draft');
        const screenshot = join(integration.dirs.root, `git-tray-${width}.png`);
        await page.screenshot({ path: screenshot });
        console.log(`Git tray screenshot: ${screenshot}`);

        markPhase(`dismissing the tooltip without stopping the running chat at ${width}px`);
        const previousStops = stopRequests;
        await gitButton.focus();
        const tooltip = page.getByRole('tooltip');
        await browserExpect(tooltip).toBeVisible();
        await gitButton.press('Escape');
        await browserExpect(tooltip).toHaveCount(0);
        await browserExpect(stop).toBeVisible();
        expect(stopRequests).toBe(previousStops);
      } finally {
        held.releaseEcho();
      }
      if (!turnId) throw new Error('Missing turn ID');
      await integration.client.waitForTurnTerminal(chats[0]!, turnId);
      await browserExpect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
      await browserExpect(gitButton).toHaveAccessibleName(statsLabel);
      expect((await composer.boundingBox())?.y).toBe(idleBox.y);
    }

    markPhase('opening Commit by keyboard');
    await gitButton.focus();
    await gitButton.press('Enter');
    await browserExpect(gitButton).toHaveCount(0);
    await browserExpect(page.getByText('new.txt', { exact: true }).first()).toBeVisible();
    assertNoBrowserErrors();
  });
}, 120_000);

for (const interaction of ['keyboard', 'hover'] as const) {
  test(`Git tooltip respects ${interaction} Escape ownership during a running chat`, async () => {
    await withChromiumFixture(`git-summary-escape-${interaction}`, async ({ page, integration, assertNoBrowserErrors }) => {
      const project = integration.executionDirs.project;
      await initializeFixtureRepository(project);
      const chatId = integration.newChatId();
      const initial = await integration.client.startDirectChat({
        chatId, content: 'git-tooltip-prime', projectPath: project, agent: integration.directAgents.openAi,
      });
      await integration.client.waitForTurnTerminal(chatId, initial.turnId);
      await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
      const gitButton = page.locator('[data-git-summary-button] button:visible');
      await gitButton.waitFor();
      let stopRequests = 0;
      page.on('request', request => {
        if (request.url().endsWith('/chats/stop')) stopRequests++;
      });
      const held = integration.fakeProviders.openAi.holdNext({ lastUserText: 'git-tooltip-held' });
      let turnId: string | null = null;
      try {
        const started = await integration.client.runDirectChat({
          chatId, content: 'git-tooltip-held', agent: integration.directAgents.openAi,
        });
        turnId = started.turnId ?? null;
        await held.received;
        const stop = page.getByRole('button', { name: 'Stop', exact: true });
        await stop.waitFor();
        const input = page.locator('[data-composer]:visible textarea');
        if (interaction === 'keyboard') await gitButton.focus();
        else {
          await input.focus();
          await gitButton.hover();
          await browserExpect(input).toBeFocused();
        }
        const tooltip = page.getByRole('tooltip');
        await browserExpect(tooltip).toBeVisible();
        if (interaction === 'keyboard') {
          await gitButton.press('Escape');
          await browserExpect(tooltip).toHaveCount(0);
          await browserExpect(stop).toBeVisible();
          expect(stopRequests).toBe(0);
        }
        const aborted = held.expectAbort();
        const stopped = page.waitForResponse(response => response.url().endsWith('/chats/stop'));
        await (interaction === 'keyboard' ? gitButton : input).press('Escape');
        expect((await stopped).ok()).toBe(true);
        await aborted;
        expect(stopRequests).toBe(1);
      } finally {
        held.releaseEcho();
      }
      if (!turnId) throw new Error('Missing turn ID');
      await integration.client.waitForTurnTerminal(chatId, turnId);
      await browserExpect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
      assertNoBrowserErrors();
    });
  }, 120_000);
}
