import { test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import { withChromiumFixture } from '../../support/chromium-fixture.js';

test('Markdown table cells keep their padding in the first and last columns', async () => {
  await withChromiumFixture('markdown-table-padding', async ({ page, integration, assertNoBrowserErrors }) => {
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
    response.releaseText('| Area | Status | Next action |\n| --- | --- | --- |\n| Interface | Ready | Review spacing |\n| Workflow | In review | Try a new chat |');
    await integration.client.waitForTurnTerminal(chatId, started.turnId);

    await page.goto(`${integration.garcon.baseUrl}/chat/${encodeURIComponent(chatId)}`);
    const cells = page.locator('.markdown-body th, .markdown-body td');
    await browserExpect(cells).toHaveCount(9);
    for (const cell of await cells.all()) {
      await browserExpect(cell).toHaveCSS('padding', '8px 12px');
    }
    assertNoBrowserErrors();
  });
}, 120_000);
