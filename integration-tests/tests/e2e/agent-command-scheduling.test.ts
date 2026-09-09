import { describe, expect, test } from 'bun:test';
import type { Page } from 'puppeteer-core';
import type { PreamblesSnapshot } from '../../../common/preambles.js';
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

async function waitForTextSequence(
  page: Page,
  selector: string,
  expectedTexts: readonly string[],
): Promise<void> {
  await page.waitForFunction(
    ({ selector, expectedTexts }) => {
      const actualTexts = [...document.querySelectorAll<HTMLElement>(selector)].map((element) =>
        element.textContent?.trim(),
      );
      return (
        actualTexts.length === expectedTexts.length &&
        actualTexts.every((text, index) => text === expectedTexts[index])
      );
    },
    { timeout: 20_000 },
    { selector, expectedTexts },
  );
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

  test('configures and restores an ordered preamble selection for scheduled new chats', async () => {
    await withE2eFixture('scheduled-preamble-selection', async (fixture) => {
      let catalog = await fixture.integration.client
        .post<{ snapshot: PreamblesSnapshot }>('/api/v1/preambles', {
          expectedRevision: 0,
          preamble: {
            enabled: true,
            title: 'Scheduled alpha rules',
            content: 'SYNTHETIC_SCHEDULED_ALPHA_BODY',
            scope: { type: 'global' },
          },
        })
        .then((response) => response.snapshot);
      catalog = await fixture.integration.client
        .post<{ snapshot: PreamblesSnapshot }>('/api/v1/preambles', {
          expectedRevision: catalog.revision,
          preamble: {
            enabled: true,
            title: 'Scheduled beta rules',
            content: 'SYNTHETIC_SCHEDULED_BETA_BODY',
            scope: { type: 'global' },
          },
        })
        .then((response) => response.snapshot);
      const alphaId = catalog.preambles.find(
        (preamble) => preamble.title === 'Scheduled alpha rules',
      )!.id;
      const betaId = catalog.preambles.find(
        (preamble) => preamble.title === 'Scheduled beta rules',
      )!.id;

      const app = new SpaDriver(fixture.page, fixture.integration);
      await fixture.page.setViewport({ width: 1_280, height: 2_000 });
      await app.open();
      await fixture.waitForSpaWebSocket();
      await app.clickButton('More actions');
      await app.waitForMenuItemEnabled('Scheduled prompts');
      await app.clickMenuItem('Scheduled prompts');
      await app.waitForButtonEnabled('Add Prompt');
      await app.clickButton('Add Prompt');
      await fixture.page.waitForFunction(
        (projectPath) =>
          document.querySelector<HTMLInputElement>('#scheduled-project-path')?.value ===
          projectPath,
        { timeout: 20_000 },
        fixture.integration.dirs.project,
      );
      await app.waitForText('Defaults are evaluated when each scheduled chat is created.');
      await app.waitForText('Current preview');
      await waitForTextSequence(fixture.page, '[data-slot="new-chat-preamble-pill"]', [
        'Scheduled alpha rules',
        'Scheduled beta rules',
      ]);
      await app.fill(
        '[data-slot="scheduled-prompt-field"] textarea',
        'Synthetic scheduled preamble task.',
      );

      await fixture.page.$eval('[data-slot="new-chat-preambles-configure"]', (element) =>
        (element as HTMLButtonElement).click(),
      );
      await waitForTextSequence(fixture.page, '[data-slot="chat-preamble-selection-row-title"]', [
        'Scheduled alpha rules',
        'Scheduled beta rules',
      ]);
      await fixture.page.evaluate(() => {
        const betaRow = [
          ...document.querySelectorAll<HTMLElement>('[data-slot="chat-preamble-selection-row"]'),
        ].find(
          (element) =>
            element
              .querySelector('[data-slot="chat-preamble-selection-row-title"]')
              ?.textContent?.trim() === 'Scheduled beta rules',
        );
        const moveUp = betaRow?.querySelector<HTMLButtonElement>(
          '[data-slot="chat-preamble-selection-move-up"]',
        );
        if (!moveUp || moveUp.disabled) throw new Error('Missing scheduled preamble move action');
        moveUp.click();
      });
      await fixture.page.waitForFunction(
        () => {
          const rows = [
            ...document.querySelectorAll<HTMLElement>('[data-slot="chat-preamble-selection-row"]'),
          ];
          const rowFor = (title: string) =>
            rows.find(
              (row) =>
                row
                  .querySelector('[data-slot="chat-preamble-selection-row-title"]')
                  ?.textContent?.trim() === title,
            );
          return (
            rowFor('Scheduled beta rules')?.querySelector<HTMLButtonElement>(
              '[data-slot="chat-preamble-selection-move-up"]',
            )?.disabled === true &&
            rowFor('Scheduled alpha rules')?.querySelector<HTMLButtonElement>(
              '[data-slot="chat-preamble-selection-move-down"]',
            )?.disabled === true
          );
        },
        { timeout: 20_000 },
      );

      await app.clickButton('Manage preambles');
      await fixture.page.waitForSelector('[data-slot="preambles-scroll-body"]');
      expect(await fixture.page.$('[data-slot="scheduled-prompt-field"] textarea')).not.toBeNull();
      await app.clickButton('Close', { last: true });
      await fixture.page.waitForFunction(
        () => {
          const rows = [
            ...document.querySelectorAll<HTMLElement>('[data-slot="chat-preamble-selection-row"]'),
          ];
          const betaRow = rows.find(
            (row) =>
              row
                .querySelector('[data-slot="chat-preamble-selection-row-title"]')
                ?.textContent?.trim() === 'Scheduled beta rules',
          );
          return (
            betaRow?.querySelector<HTMLButtonElement>(
              '[data-slot="chat-preamble-selection-move-up"]',
            )?.disabled === true &&
            document.activeElement?.matches('[data-slot="new-chat-preamble-manage-catalog"]') ===
              true
          );
        },
        { timeout: 20_000 },
      );
      await app.clickButton('Apply');
      await waitForTextSequence(fixture.page, '[data-slot="new-chat-preamble-pill"]', [
        'Scheduled beta rules',
        'Scheduled alpha rules',
      ]);
      await app.waitForText(
        'This ordered selection is reused when each scheduled chat is created.',
      );
      await app.waitForButtonEnabled('Save Prompt');
      await app.clickButton('Save Prompt');
      await app.waitForText('Synthetic scheduled preamble task.');
      await app.waitForText('2 preambles selected');

      const saved = (await fixture.integration.client.getScheduledPrompts()).prompts.find(
        (prompt) => prompt.prompt === 'Synthetic scheduled preamble task.',
      );
      expect(saved?.target).toMatchObject({
        type: 'new-chat',
        preambleChoice: {
          mode: 'explicit',
          orderedPreambleIds: [betaId, alphaId],
        },
      });

      await app.clickButton('Edit prompt');
      await app.waitForText(
        'This ordered selection is reused when each scheduled chat is created.',
      );
      await waitForTextSequence(fixture.page, '[data-slot="new-chat-preamble-pill"]', [
        'Scheduled beta rules',
        'Scheduled alpha rules',
      ]);
      await fixture.page.$eval('[data-slot="new-chat-preambles-configure"]', (element) =>
        (element as HTMLButtonElement).click(),
      );
      await fixture.page.waitForFunction(
        () => {
          const betaRow = [
            ...document.querySelectorAll<HTMLElement>('[data-slot="chat-preamble-selection-row"]'),
          ].find(
            (row) =>
              row
                .querySelector('[data-slot="chat-preamble-selection-row-title"]')
                ?.textContent?.trim() === 'Scheduled beta rules',
          );
          return (
            betaRow?.querySelector<HTMLButtonElement>(
              '[data-slot="chat-preamble-selection-move-up"]',
            )?.disabled === true
          );
        },
        { timeout: 20_000 },
      );
      fixture.assertNoBrowserErrors();
    });
  }, 90_000);
});
