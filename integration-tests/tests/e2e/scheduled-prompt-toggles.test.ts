import { expect, test } from 'bun:test';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { SpaDriver } from '../../support/spa-driver.js';

test('pauses and resumes a scheduled prompt through the SPA', async () => {
  await withE2eFixture('scheduled-prompt-toggles', async fixture => {
    const { integration, page } = fixture;
    const chatId = integration.newChatId();
    const turn = await integration.client.startDirectChat({ chatId, content: 'Synthetic schedule target', projectPath: integration.executionDirs.project, agent: integration.directAgents.openAi });
    await integration.client.waitForTurnTerminal(chatId, turn.turnId);
    await integration.client.createScheduledPrompt({ expectedRevision: 0, scheduledPrompt: {
      name: 'Synthetic recurring review', prompt: 'Synthetic scheduled prompt',
      target: { type: 'existing-chat', chatId, busyBehavior: 'skip' },
      schedule: { type: 'recurring', firstRunAtUtc: '2030-01-02T09:00:00.000Z', intervalMinutes: 60, endAtUtc: null },
    } });
    const app = new SpaDriver(page, integration);
    await app.open();
    await fixture.waitForSpaWebSocket();
    const open = async () => {
      await app.clickButton('More actions');
      await app.waitForMenuItemEnabled('Scheduled prompts');
      await app.clickMenuItem('Scheduled prompts');
      await app.waitForText('Synthetic recurring review');
    };
    await open();
    const selector = 'article button[role="switch"]';
    await page.waitForSelector(selector + '[aria-checked="true"]');
    await page.$eval(selector, element => (element as HTMLButtonElement).click());
    await page.waitForSelector(selector + '[aria-checked="false"]');
    await app.waitForText('Paused');
    expect((await integration.client.getScheduledPrompts()).prompts[0]?.enabled).toBe(false);
    await page.reload();
    await fixture.waitForSpaWebSocket();
    await open();
    await page.waitForSelector(selector + '[aria-checked="false"]');
    await page.$eval(selector, element => (element as HTMLButtonElement).click());
    await page.waitForSelector(selector + '[aria-checked="true"]');
    expect((await integration.client.getScheduledPrompts()).prompts[0]?.enabled).toBe(true);
  });
}, 120_000);
