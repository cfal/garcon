import { expect, test } from 'bun:test';
import type { Page } from 'puppeteer-core';
import { codexAssistantMessage } from '../../support/fake-codex-model.js';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import type { IntegrationDirectories } from '../../support/integration-fixture.js';
import { liveCodexStartRequest } from '../../support/live-codex.js';
import { waitForPersistedChat } from '../../support/persisted-chat.js';
import { startScriptedCodexTestEnvironment } from '../../support/scripted-codex.js';
import { SpaDriver } from '../../support/spa-driver.js';

const FAST_MODE_TRIGGER = '#agent-setting-codex-codexFastMode';

async function waitForFastMode(page: Page, mode: 'On' | 'Off'): Promise<void> {
  await page.waitForFunction(
    ({ selector, label }) => document.querySelector(selector)?.getAttribute('aria-label') === label,
    { timeout: 20_000 },
    { selector: FAST_MODE_TRIGGER, label: `Fast mode: ${mode}` },
  );
}

async function openFastModeMenu(page: Page): Promise<void> {
  await page.$eval(FAST_MODE_TRIGGER, (element) => {
    (element as HTMLElement).focus();
    element.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      bubbles: true,
      cancelable: true,
    }));
  });
  await page.waitForFunction(
    () => [...document.querySelectorAll('[role="menuitemradio"]')]
      .filter((element) => !element.closest('[aria-hidden="true"]')).length === 2,
    { timeout: 20_000 },
  );
}

async function selectOpenFastModeOption(page: Page, mode: 'On' | 'Off'): Promise<void> {
  await page.evaluate((expected) => {
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
      .filter((element) => !element.closest('[aria-hidden="true"]'))
      .find((element) => element.textContent?.trim().startsWith(expected));
    if (!item) throw new Error(`Missing Fast mode option: ${expected}`);
    item.click();
  }, mode);
  await waitForFastMode(page, mode);
}

async function selectFastMode(page: Page, mode: 'On' | 'Off'): Promise<void> {
  await openFastModeMenu(page);
  await selectOpenFastModeOption(page, mode);
}

async function waitForPersistedFastMode(
  directories: IntegrationDirectories,
  chatId: string,
  expected: 'on' | 'off',
): Promise<void> {
  await waitForPersistedChat({
    directories,
    chatId,
    timeoutMessage: `Chat ${chatId} did not persist Codex Fast mode ${expected}.`,
    select: (chat) => {
      const settingsById = chat.agentSettingsById;
      if (!settingsById || typeof settingsById !== 'object' || Array.isArray(settingsById)) {
        return null;
      }
      const settings = (settingsById as Record<string, unknown>).codex;
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return null;
      const values = (settings as Record<string, unknown>).values;
      if (!values || typeof values !== 'object' || Array.isArray(values)) return null;
      return (values as Record<string, unknown>).codexFastMode === expected ? true : null;
    },
  });
}

test('toggles per-chat Codex Fast mode through the composer', async () => {
  const environment = await startScriptedCodexTestEnvironment({ supportsPriority: true });
  try {
    await withE2eFixture('codex-fast-mode', async (fixture) => {
      const app = new SpaDriver(fixture.page, fixture.integration);
      const chatId = fixture.integration.newChatId();
      environment.model.scriptTurn([codexAssistantMessage('fast mode seed reply')]);
      const seedCursor = fixture.integration.client.markEvents();
      const seed = await fixture.integration.client.startChat(liveCodexStartRequest({
        chatId,
        projectPath: fixture.integration.dirs.project,
        command: 'fast mode seed prompt',
        fastMode: 'off',
      }));
      await fixture.integration.client.waitForTurnTerminal(chatId, seed.turnId, {
        afterIndex: seedCursor,
      });

      await app.openChat(chatId);
      await fixture.waitForSpaWebSocket();
      await waitForFastMode(fixture.page, 'Off');
      await openFastModeMenu(fixture.page);
      const options = await fixture.page.$$eval(
        '[role="menuitemradio"]',
        (items) => items
          .filter((item) => !item.closest('[aria-hidden="true"]'))
          .map((item) => ({
            label: item.querySelector('.font-medium')?.textContent?.trim() ?? '',
            state: item.getAttribute('data-state'),
          })),
      );
      expect(options).toEqual([
        { label: 'On', state: 'unchecked' },
        { label: 'Off', state: 'checked' },
      ]);

      await selectOpenFastModeOption(fixture.page, 'On');
      await waitForPersistedFastMode(fixture.integration.dirs, chatId, 'on');
      environment.model.scriptTurn([codexAssistantMessage('priority composer reply')]);
      const priorityMarker = environment.model.markRequests();
      await app.sendComposer('priority composer prompt');
      await app.waitForText('priority composer reply', 40_000);
      const priorityRequests = environment.model.requestsSince(priorityMarker);
      expect(priorityRequests).toHaveLength(1);
      expect(priorityRequests[0]!.body.service_tier).toBe('priority');

      await selectFastMode(fixture.page, 'Off');
      await waitForPersistedFastMode(fixture.integration.dirs, chatId, 'off');
      environment.model.scriptTurn([codexAssistantMessage('standard composer reply')]);
      const standardMarker = environment.model.markRequests();
      await app.sendComposer('standard composer prompt');
      await app.waitForText('standard composer reply', 40_000);
      const standardRequests = environment.model.requestsSince(standardMarker);
      expect(standardRequests).toHaveLength(1);
      expect(standardRequests[0]!.body).not.toHaveProperty('service_tier');

      await selectFastMode(fixture.page, 'On');
      await waitForPersistedFastMode(fixture.integration.dirs, chatId, 'on');
      const held = environment.model.scriptHeldTurn([
        codexAssistantMessage('held priority composer reply'),
      ]);
      try {
        environment.model.scriptTurn([codexAssistantMessage('queued standard composer reply')]);
        const queueMarker = environment.model.markRequests();
        await app.sendComposer('held priority composer prompt');
        expect((await held.requested).body.service_tier).toBe('priority');
        await app.waitForChatProcessing(true);

        await selectFastMode(fixture.page, 'Off');
        await app.sendComposer('queued after disabling fast mode');
        await app.waitForQueuedPreview('queued after disabling fast mode');
        await waitForPersistedFastMode(fixture.integration.dirs, chatId, 'off');
        held.release();
        await app.waitForText('queued standard composer reply', 60_000);

        const queuedRequests = environment.model.requestsSince(queueMarker);
        expect(queuedRequests).toHaveLength(2);
        const queuedRequest = queuedRequests.find((request) =>
          request.lastUserText.includes('queued after disabling fast mode'));
        expect(queuedRequest).toBeDefined();
        expect(queuedRequest!.body).not.toHaveProperty('service_tier');
      } finally {
        held.release();
      }

      const nonCodexChatId = fixture.integration.newChatId();
      const directCursor = fixture.integration.client.markEvents();
      const direct = await fixture.integration.client.startDirectChat({
        chatId: nonCodexChatId,
        projectPath: fixture.integration.dirs.project,
        agent: fixture.integration.directAgents.openAi,
        content: 'non-Codex fast control check',
      });
      await fixture.integration.client.waitForTurnTerminal(nonCodexChatId, direct.turnId, {
        afterIndex: directCursor,
      });
      const connectionCount = await fixture.spaWebSocketConnectionCount();
      await app.openChat(nonCodexChatId);
      await fixture.waitForSpaWebSocket({ afterConnectionCount: connectionCount });
      await fixture.page.waitForSelector('textarea[placeholder="Reply..."]');
      expect(await fixture.page.$(FAST_MODE_TRIGGER)).toBeNull();
      expect(await fixture.page.evaluate(() => [...document.querySelectorAll('button')].some(
        (button) => button.getAttribute('aria-label')?.startsWith('Fast mode:') === true,
      ))).toBe(false);

      environment.model.assertSettled();
      fixture.assertNoBrowserErrors();
    }, {
      serverEnvironment: environment.serverEnvironment,
      prepareWorkspace: environment.prepareWorkspace,
    });
  } finally {
    await environment.dispose();
  }
}, 180_000);
