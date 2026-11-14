import { test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { seedLocalSettings } from '../../support/local-settings-seed.js';

test('Markdown tables retain padding in edge columns across themes and viewport sizes', async () => {
  await withChromiumFixture('markdown-table-padding', async ({ page, integration, assertNoBrowserErrors }) => {
    await page.addInitScript(seedLocalSettings, { composerStatusBarGitProjects: false, composerStatusBarNonGitProjects: false });
    const prompt = 'Show the release checklist as a table.';
    const response = integration.fakeProviders.openAi.holdNext({ lastUserText: prompt });
    const chatId = integration.newChatId();
    const started = await integration.client.startDirectChat({
      chatId,
      content: prompt,
      projectPath: integration.dirs.project,
      agent: integration.directAgents.openAi,
    });
    await response.received;
    response.releaseText('## Release checklist\n\n| Area | Status | Next action |\n| --- | --- | --- |\n| Interface | Ready | Review spacing |\n| Workflow | In review | Try a new chat |');
    await integration.client.waitForTurnTerminal(chatId, started.turnId);
    await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
    const cells = page.locator('.markdown-body th, .markdown-body td');
    await browserExpect(cells).toHaveCount(9);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const theme of ['light', 'dark']) {
        await page.evaluate((theme) => document.documentElement.classList.toggle('dark', theme === 'dark'), theme);
        for (const cell of await cells.all()) {
          await browserExpect(cell).toHaveCSS('padding-top', '8px');
          await browserExpect(cell).toHaveCSS('padding-bottom', '8px');
          await browserExpect(cell).toHaveCSS('padding-left', '12px');
          await browserExpect(cell).toHaveCSS('padding-right', '12px');
        }
      }
    }
    assertNoBrowserErrors();
  });
}, 120_000);
