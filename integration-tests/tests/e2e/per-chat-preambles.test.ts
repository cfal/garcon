import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { PreamblesSnapshot } from '../../../common/preambles.js';
import type { ChatPreambleSelectionTargetResponse } from '../../../common/chat-preamble-selection-contracts.js';
import type { ChatListResponse } from '../../../common/chat-list.js';
import { TranscriptNoticeMessage } from '../../../common/chat-types.js';
import { SpaDriver } from '../../support/spa-driver.js';
import {
  type E2eFixture,
  withE2eFixture,
} from '../../support/e2e-fixture.js';

async function exposeTranscriptViewport(fixture: E2eFixture): Promise<void> {
  await fixture.page.waitForFunction(
    () => document.querySelector('[data-chat-scroll-viewport]')?.getAttribute('aria-busy')
      === 'false',
    { timeout: 20_000 },
  );
  await fixture.page.$eval('[data-chat-scroll-viewport]', (element) => {
    Object.defineProperty(element, 'clientHeight', {
      configurable: true,
      get: () => 720,
    });
    element.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
}

async function visibleTextCount(fixture: E2eFixture, selector: string, text: string): Promise<number> {
  return fixture.page.evaluate(
    ({ selector, text }) => [...document.querySelectorAll<HTMLElement>(selector)]
      .filter((element) => element.textContent?.trim() === text)
      .length,
    { selector, text },
  );
}

describe('Lightpanda per-chat preambles', () => {
  test('[PREAMBLE-SELECTION.03-LIGHTPANDA-01] configures a new chat selection and applies chat order', async () => {
    await withE2eFixture('per-chat-preambles', async (fixture) => {
      const app = new SpaDriver(fixture.page, fixture.integration);
      await fixture.page.setViewport({ width: 1_280, height: 2_000 });
      await app.open();
      await fixture.waitForSpaWebSocket();

      // Seed the catalog with two enabled global preambles through the API.
      let catalog: PreamblesSnapshot = await fixture.integration.client.post<{ snapshot: PreamblesSnapshot }>('/api/v1/preambles', {
        expectedRevision: 0,
        preamble: {
          enabled: true,
          title: 'Alpha rules',
          content: 'SYNTHETIC_ALPHA_BODY',
          scope: { type: 'global' },
        },
      }).then((response) => response.snapshot);
      catalog = await fixture.integration.client.post<{ snapshot: PreamblesSnapshot }>('/api/v1/preambles', {
        expectedRevision: catalog.revision,
        preamble: {
          enabled: true,
          title: 'Beta rules',
          content: 'SYNTHETIC_BETA_BODY',
          scope: { type: 'global' },
        },
      }).then((response) => response.snapshot);
      const alphaId = catalog.preambles.find((preamble) => preamble.title === 'Alpha rules')!.id;
      const betaId = catalog.preambles.find((preamble) => preamble.title === 'Beta rules')!.id;

      // Open the New Chat dialog and wait for it to settle.
      await app.clickButton('New Chat');
      await fixture.page.waitForFunction(
        () => {
          const dialog = document.querySelector('[role="dialog"]');
          return (
            dialog !== null &&
            dialog.querySelector('[role="status"][aria-label="Loading chat defaults..."]') === null
          );
        },
        { timeout: 20_000 },
      );
      // The defaults preview count covers both catalog entries.
      await fixture.page.waitForFunction(
        () => document.querySelector('[data-slot="new-chat-preambles-label"]') !== null,
        { timeout: 20_000 },
      );
      await fixture.page.waitForFunction(
        (count) => document.querySelector('[data-slot="new-chat-preambles-label"]')?.textContent
          ?.includes(count),
        { timeout: 20_000 },
        '2',
      );

      // Customize to an explicit reversed order through the picker.
      await fixture.page.evaluate(() => {
        const button = document.querySelector<HTMLButtonElement>(
          '[data-slot="new-chat-preambles-configure"]',
        );
        if (!button) throw new Error('Missing new-chat preambles configure action');
        button.click();
      });
      await fixture.page.waitForFunction(
        (title) => [...document.querySelectorAll<HTMLElement>('[data-slot="chat-preamble-selection-row-title"]')]
          .some((element) => element.textContent?.trim() === title),
        { timeout: 20_000 },
        'Alpha rules',
      );
      await fixture.page.evaluate((title) => {
        const row = [...document.querySelectorAll<HTMLElement>(
          '[data-slot="chat-preamble-selection-row"]',
        )].find((element) => element.querySelector(
          '[data-slot="chat-preamble-selection-row-title"]',
        )?.textContent?.trim() === title);
        const button = row?.querySelector<HTMLButtonElement>(
          '[data-slot="chat-preamble-selection-move-up"]',
        );
        if (!button || button.disabled) throw new Error(`Missing or disabled move action: ${title}`);
        button.click();
      }, 'Beta rules');
      await fixture.page.waitForFunction(
        (titles) => [...document.querySelectorAll<HTMLElement>('[data-slot="chat-preamble-selection-row-title"]')]
          .map((element) => element.textContent?.trim())
          .join('|') === titles,
        { timeout: 20_000 },
        'Beta rules|Alpha rules',
      );
      await fixture.page.evaluate(() => {
        const button = document.querySelector<HTMLButtonElement>(
          '[data-slot="new-chat-preamble-apply"]',
        );
        if (!button || button.disabled) throw new Error('Missing or disabled new-chat preamble apply');
        button.click();
      });
      await fixture.page.waitForFunction(
        () => document.querySelector('[data-slot="new-chat-preamble-scroll-body"]') === null,
        { timeout: 20_000 },
      );
      // The form now shows the reset affordance of an explicit choice.
      await fixture.page.waitForFunction(
        () => document.querySelector('[data-slot="new-chat-preambles-reset"]') !== null,
        { timeout: 20_000 },
      );

      await app.ensureDirectModelSelected({
        selectedAgentLabel: 'Direct (Chat Completions)',
        optionAgentLabel: 'Chat Completions',
        modelLabel: 'Integration Echo',
      });
      await app.fill(
        '[role="dialog"] textarea[placeholder="How can I help you today?"]',
        'per-chat boundary prompt',
      );
      await app.waitForDialogButtonEnabled('Start session');
      const held = fixture.integration.fakeProviders.openAi.holdNext({
        model: fixture.integration.directAgents.openAi.provider.model,
      });
      await app.clickButton('Start session');
      const providerRequest = await fixture.integration.fakeProviders.openAi.waitForRequest(
        { model: fixture.integration.directAgents.openAi.provider.model },
        { timeoutMs: 20_000 },
      );
      await held.received;
      const requestText = providerRequest.lastUserText;
      expect(requestText).toContain('SYNTHETIC_BETA_BODY');
      expect(requestText.indexOf('SYNTHETIC_BETA_BODY')).toBeLessThan(requestText.indexOf('SYNTHETIC_ALPHA_BODY'));
      expect(held.releaseText('per-chat synthetic response')).toBeTrue();

      await exposeTranscriptViewport(fixture);
      await fixture.page.waitForFunction(
        () => [...document.querySelectorAll<HTMLElement>('[data-slot="preamble-application-title"]')]
          .map((element) => element.textContent?.trim())
          .join('|') === 'Beta rules|Alpha rules',
        { timeout: 20_000 },
      );

      // The persisted registry selection keeps both explicit IDs.
      const target = await fixture.integration.client.get<ChatPreambleSelectionTargetResponse>(
        `/api/v1/chats/preambles?chatId=${await currentChatId(fixture)}`,
      );
      expect(new Set(target.selection.orderedPreambleIds)).toEqual(new Set([alphaId, betaId]));
    });
  });

  test('[PREAMBLE-SELECTION.03-LIGHTPANDA-02] configures an existing chat from its menu and applies on the next message', async () => {
    await withE2eFixture('per-chat-preambles-existing', async (fixture) => {
      const app = new SpaDriver(fixture.page, fixture.integration);
      await fixture.page.setViewport({ width: 1_280, height: 2_000 });
      await app.open();
      await fixture.waitForSpaWebSocket();

      const firstHeld = fixture.integration.fakeProviders.openAi.holdNext({
        model: fixture.integration.directAgents.openAi.provider.model,
      });
      await app.startOpenAiDirectChat('existing chat first prompt', {
        requestMatcher: { model: fixture.integration.directAgents.openAi.provider.model },
      });
      await firstHeld.received;
      expect(firstHeld.releaseText('existing first response')).toBeTrue();

      // The chat predates the catalog entry, so its saved selection is empty.
      const catalog: PreamblesSnapshot = await fixture.integration.client.post<{ snapshot: PreamblesSnapshot }>('/api/v1/preambles', {
        expectedRevision: 0,
        preamble: {
          enabled: true,
          title: 'Existing rules',
          content: 'SYNTHETIC_EXISTING_BODY',
          scope: { type: 'global' },
        },
      }).then((response) => response.snapshot);

      // Configure preambles from the chat window's own surface menu; the
      // callback captures the window's chat, not the sidebar selection.
      await app.clickButton('Window actions');
      await app.waitForMenuItemEnabled('Configure preambles');
      await app.clickMenuItem('Configure preambles');

      await fixture.page.waitForFunction(
        () => document.querySelector('[data-slot="chat-preamble-selection-save"]') !== null,
        { timeout: 20_000 },
      );
      // The empty saved selection shows None enabled.
      await fixture.page.waitForFunction(
        () => document.querySelector('[data-slot="chat-preamble-selection-empty"]') !== null,
        { timeout: 20_000 },
      );
      await fixture.page.evaluate(() => {
        const button = document.querySelector<HTMLButtonElement>(
          '[data-slot="chat-preamble-selection-toggle-candidates"]',
        );
        if (!button) throw new Error('Missing selection candidates toggle');
        button.click();
      });
      await fixture.page.waitForFunction(
        (title) => document.querySelector('[data-slot="chat-preamble-selection-candidates"]')
          ?.textContent?.includes(title),
        { timeout: 20_000 },
        'Existing rules',
      );
      await fixture.page.evaluate((title) => {
        const row = [...document.querySelectorAll<HTMLElement>(
          '[data-slot="chat-preamble-selection-candidate"]',
        )].find((element) => element.querySelector(
          '[data-slot="chat-preamble-selection-candidate-title"]',
        )?.textContent?.trim() === title);
        const button = row?.querySelector<HTMLButtonElement>(
          '[data-slot="chat-preamble-selection-candidate-add"]',
        );
        if (!button) throw new Error(`Missing add action for ${title}`);
        button.click();
      }, 'Existing rules');
      const providerRequestCountBeforeSave = fixture.integration.fakeProviders.openAi.requests().length;
      await fixture.page.evaluate(() => {
        const button = document.querySelector<HTMLButtonElement>(
          '[data-slot="chat-preamble-selection-save"]',
        );
        if (!button || button.disabled) throw new Error('Missing or disabled selection save');
        button.click();
      });

      // The committed update notice is the browser-visible Save barrier.
      await fixture.page.waitForFunction(
        (title) => [...document.querySelectorAll<HTMLElement>(
          '[data-slot="preamble-selection-changed-title"]',
        )].some((element) => element.textContent?.trim() === title),
        { timeout: 20_000 },
        'Existing rules',
      );

      // Once the WS row is visible, one authoritative read verifies the
      // registry decision without timing-based polling.
      const chatIdForSave = await currentChatId(fixture);
      const savedTarget = await fixture.integration.client.get<ChatPreambleSelectionTargetResponse>(
        `/api/v1/chats/preambles?chatId=${chatIdForSave}`,
      );
      expect(savedTarget.selection.revision).toBe(1);
      expect(savedTarget.selection.orderedPreambleIds).toEqual([catalog.preambles[0]!.id]);
      const savedHistory = await fixture.integration.client.getMessages(chatIdForSave);
      const savedNotice = savedHistory.messages
        .map((entry) => entry.message)
        .find((message): message is TranscriptNoticeMessage => message instanceof TranscriptNoticeMessage
          && message.detail?.type === 'preamble-selection-changed');
      expect(savedNotice?.content).toBe('Preambles updated');
      expect(savedNotice?.detail?.type === 'preamble-selection-changed'
        ? savedNotice.detail.preambles
        : []).toEqual([{ id: catalog.preambles[0]!.id, title: 'Existing rules' }]);
      expect(fixture.integration.fakeProviders.openAi.requests()).toHaveLength(
        providerRequestCountBeforeSave,
      );

      await fixture.page.evaluate(() => {
        const button = document.querySelector<HTMLButtonElement>(
          '[data-slot="chat-preamble-selection-cancel"]',
        );
        if (!button || button.disabled) throw new Error('Missing selection close action');
        button.click();
      });
      await fixture.page.waitForFunction(
        () => document.querySelector('[data-slot="chat-preamble-selection-dialog"]') === null,
        { timeout: 20_000 },
      );

      const applied = fixture.integration.fakeProviders.openAi.holdNext({
        model: fixture.integration.directAgents.openAi.provider.model,
      });
      await app.sendComposer('existing chat applies selection');
      const appliedRequest = await applied.received;
      expect(appliedRequest.lastUserText).toContain('SYNTHETIC_EXISTING_BODY');
      expect(appliedRequest.lastUserText).toContain('existing chat applies selection');
      expect(applied.releaseText('selection applied response')).toBeTrue();
      await app.waitForText('selection applied response');
      await exposeTranscriptViewport(fixture);
      await fixture.page.waitForFunction(
        (title) => [...document.querySelectorAll<HTMLElement>(
          '[data-slot="preamble-application-title"]',
        )].some((element) => element.textContent?.trim() === title),
        { timeout: 20_000 },
        'Existing rules',
      );

      const ordinary = fixture.integration.fakeProviders.openAi.holdNext({
        model: fixture.integration.directAgents.openAi.provider.model,
      });
      await app.sendComposer('existing chat ordinary follow-up');
      const ordinaryRequest = await ordinary.received;
      expect(ordinaryRequest.lastUserText).toBe('existing chat ordinary follow-up');
      expect(ordinaryRequest.lastUserText).not.toContain('SYNTHETIC_EXISTING_BODY');
      expect(ordinary.releaseText('ordinary follow-up response')).toBeTrue();
      await app.waitForText('ordinary follow-up response');
      expect(await visibleTextCount(
        fixture,
        '[data-slot="preamble-application-title"]',
        'Existing rules',
      )).toBe(1);
      fixture.assertNoBrowserErrors();
    });
  });
});

async function currentChatId(fixture: E2eFixture): Promise<string> {
  const chats = await fixture.integration.client.get<ChatListResponse>('/api/v1/chats');
  return chats.sessions.at(-1)!.id;
}
