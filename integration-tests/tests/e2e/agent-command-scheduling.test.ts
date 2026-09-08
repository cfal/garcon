import { describe, expect, test } from 'bun:test';
import type { Page } from 'puppeteer-core';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { SpaDriver } from '../../support/spa-driver.js';

async function selectRadio(page: Page, name: string, value: string): Promise<void> {
  const selector = `input[name="${name}"]`;
  await page.waitForSelector(selector);
  await page.$$eval(selector, (elements, value) => {
    const input = elements.find((element) => (element as HTMLInputElement).value === value);
    if (!input) throw new Error(`Missing radio option: ${value}`);
    (input as HTMLInputElement).click();
  }, value);
}

describe('Lightpanda minute scheduling', () => {
  test('creates and edits minute schedules without existing-chat execution controls and preserves them across reload', async () => {
    await withE2eFixture('agent-command-scheduling', async (fixture) => {
      const integration = fixture.integration;
      const chatId = integration.newChatId();
      const turn = await integration.client.startDirectChat({ chatId, content: 'Synthetic schedule target.', projectPath: integration.dirs.project, agent: integration.directAgents.openAi });
      await integration.client.waitForTurnTerminal(chatId, turn.turnId);
      const firstRunAtUtc = new Date(Math.ceil((Date.now() + 3_600_000) / 60_000) * 60_000).toISOString();
      await integration.client.createScheduledPrompt({ expectedRevision: 0, scheduledPrompt: {
        target: { type: 'existing-chat', chatId, busyBehavior: 'queue' },
        schedule: { type: 'recurring', firstRunAtUtc, intervalMinutes: 90, endAtUtc: null },
        prompt: '<garcon-schedule-action>\nReview A &amp; B\n</garcon-schedule-action>',
      } });
      const app = new SpaDriver(fixture.page, integration);
      const openSchedules = async () => {
        await app.clickButton('More actions');
        await app.waitForMenuItemEnabled('Scheduled prompts');
        await app.clickMenuItem('Scheduled prompts');
        await app.waitForText('Review A & B');
      };
      await app.open();
      await fixture.waitForSpaWebSocket();
      await openSchedules();
      await app.waitForText('Every 90 minutes');
      await app.clickButton('Edit prompt');
      await fixture.page.waitForSelector('#scheduled-prompt-interval');
      expect(await fixture.page.$eval('select[aria-label="Interval unit"]', (element) => (element as HTMLSelectElement).value)).toBe('minutes');
      expect(await fixture.page.$eval('#scheduled-prompt-interval', (element) => (element as HTMLInputElement).value)).toBe('90');
      expect(await fixture.page.$('[role="dialog"] [aria-label="Project Path"]')).toBeNull();
      expect(await fixture.page.$('[role="dialog"] [data-slot="scheduled-new-chat-composer"]')).toBeNull();
      await fixture.page.$eval('#scheduled-prompt-interval', (element) => {
        (element as HTMLInputElement).value = '5'; element.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await selectRadio(fixture.page, 'busy-behavior', 'skip');
      await app.waitForButtonEnabled('Save Prompt');
      await app.clickButton('Save Prompt');
      await app.waitForText('Every 5 minutes');
      const saved = await integration.client.getScheduledPrompts();
      expect(saved.prompts[0]).toMatchObject({
        schedule: { intervalMinutes: 5, nextRunAt: firstRunAtUtc },
        target: { type: 'existing-chat', chatId, busyBehavior: 'skip' },
      });
      await app.clickButton('Add Prompt');
      await selectRadio(fixture.page, 'schedule-cadence', 'recurring');
      await fixture.page.select('select[aria-label="Interval unit"]', 'minutes');
      await app.fill('#scheduled-prompt-interval', '5');
      await selectRadio(fixture.page, 'chat-target', 'existing-chat');
      await app.clickButton('Select chat');
      await fixture.page.waitForSelector('input[placeholder="Search chats..."]');
      await fixture.page.$eval('input[placeholder="Search chats..."]', (element) => {
        element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });
      await fixture.page.waitForSelector('[data-slot="scheduled-prompt-field"] textarea');
      await app.fill('[data-slot="scheduled-prompt-field"] textarea', 'Synthetic five-minute follow-up.');
      await app.waitForButtonEnabled('Save Prompt');
      await fixture.page.$eval('[data-slot="scheduled-prompt-field"] textarea', (element) => {
        element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
      });
      await app.waitForText('Synthetic five-minute follow-up.');
      const created = (await integration.client.getScheduledPrompts()).prompts;
      expect(created).toHaveLength(2);
      expect(created.find((prompt) => prompt.prompt === 'Synthetic five-minute follow-up.')).toMatchObject({
        schedule: { type: 'recurring', intervalMinutes: 5 },
        target: { type: 'existing-chat', chatId, busyBehavior: 'queue' },
      });
      const connections = await fixture.spaWebSocketConnectionCount();
      await fixture.page.reload({ waitUntil: [] });
      await fixture.waitForSpaWebSocket({ afterConnectionCount: connections });
      await openSchedules();
      await app.waitForText('Every 5 minutes');
      await app.waitForText('Synthetic five-minute follow-up.');
      fixture.assertNoBrowserErrors();
    });
  }, 90_000);
});
