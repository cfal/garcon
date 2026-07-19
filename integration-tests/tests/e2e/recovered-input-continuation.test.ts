import { describe, expect, test } from 'bun:test';
import type { HTTPRequest } from 'puppeteer-core';
import { Deferred, withTimeout } from '../../support/deferred.js';
import { withE2eFixture, type E2eFixture } from '../../support/e2e-fixture.js';
import { SpaDriver } from '../../support/spa-driver.js';

async function restartWithRecoveredInput(
  fixture: E2eFixture,
  input: {
    chatId: string;
    predecessor: string;
    queued?: string;
    pause?: boolean;
  },
): Promise<void> {
  const held = fixture.integration.fakeProviders.openAi.holdNext({
    lastUserText: input.predecessor,
  });
  const accepted = await fixture.integration.client.startDirectChat({
    chatId: input.chatId,
    content: input.predecessor,
    projectPath: fixture.integration.dirs.project,
    agent: fixture.integration.directAgents.openAi,
  });
  await held.received;
  if (input.queued) await fixture.integration.client.enqueueNew(input.chatId, input.queued);
  if (input.pause) await fixture.integration.client.pauseQueue(input.chatId);
  const aborted = held.expectAbort();
  await fixture.integration.crashAndRestartBeforeNativeUserPersistence({
    chatId: input.chatId,
    clientRequestId: accepted.clientRequestId,
  });
  await aborted;
  held.releaseTruncatedStream();
}

async function restartWithNativeRecoveredInput(
  fixture: E2eFixture,
  input: { chatId: string; predecessor: string; queued: string },
): Promise<void> {
  const held = fixture.integration.fakeProviders.openAi.holdNext({
    lastUserText: input.predecessor,
  });
  await fixture.integration.client.startDirectChat({
    chatId: input.chatId,
    content: input.predecessor,
    projectPath: fixture.integration.dirs.project,
    agent: fixture.integration.directAgents.openAi,
  });
  await held.received;
  await fixture.integration.client.enqueueNew(input.chatId, input.queued);
  const aborted = held.expectAbort();
  await fixture.integration.crashAndRestartGarcon();
  await aborted;
  held.releaseTruncatedStream();
}

describe('Lightpanda recovered input continuation', () => {
  test('keeps empty recovery silent and treats composer Send as continuation', async () => {
    await withE2eFixture('empty-recovered-input-continuation', async (fixture) => {
      const app = new SpaDriver(fixture.page, fixture.integration);
      const chatId = fixture.integration.newChatId();
      const predecessor = 'ui-unconfirmed-predecessor';
      const successor = 'ui-direct-successor';
      await restartWithRecoveredInput(fixture, { chatId, predecessor });

      await app.openChat(chatId);
      await fixture.waitForSpaWebSocket();
      await app.waitForExactTextCount(predecessor, 1);
      await app.waitForAriaLabel('Delivery not confirmed');
      const initialBody = await app.bodyText();
      expect(initialBody).not.toContain('Queue needs attention');
      expect(await app.hasButton('Continue queue')).toBe(false);
      expect(await app.hasButton('Resume queue')).toBe(false);
      expect(await app.hasButton('Edit queue')).toBe(false);
      expect(await app.queuedPreviewText()).toBeNull();
      await fixture.page.evaluate(() => {
        const composer = document.querySelector<HTMLElement>('[data-composer]');
        if (!composer) throw new Error('Composer was not rendered.');
        composer.dataset.recoveryContinuationTest = 'stable';
      });

      const heldSuccessor = fixture.integration.fakeProviders.openAi.holdNext({ lastUserText: successor });
      await app.sendComposer(successor);
      await heldSuccessor.received;
      expect(await app.queuedPreviewText()).toBeNull();
      expect((await fixture.integration.client.getExecutionControl(chatId))).toMatchObject({
        queue: { entries: [], pause: null },
        recoveredInputContinuation: null,
      });
      expect(await fixture.page.evaluate(() => (
        document.querySelector<HTMLElement>('[data-composer]')
          ?.dataset.recoveryContinuationTest === 'stable'
      ))).toBe(true);

      heldSuccessor.releaseEcho();
      await app.waitForText(`echo:${successor}`);
      await app.waitForExactTextCount(predecessor, 1);
      await app.waitForExactTextCount(successor, 1);
      expect(fixture.integration.fakeProviders.openAi.requests().filter((request) => (
        request.lastUserText === successor
      ))).toHaveLength(1);
      fixture.assertNoBrowserErrors();
    });
  }, 45_000);

  test('keeps Continue and Resume independent across queue browsing and reload', async () => {
    await withE2eFixture('queued-recovered-input-continuation', async (fixture) => {
      const app = new SpaDriver(fixture.page, fixture.integration);
      const chatId = fixture.integration.newChatId();
      const predecessor = 'ui-blocked-predecessor';
      const queuedB = 'ui-blocked-successor-b';
      const queuedC = 'ui-blocked-successor-c';
      await restartWithRecoveredInput(fixture, {
        chatId,
        predecessor,
        queued: queuedB,
        pause: true,
      });

      await app.openChat(chatId);
      await fixture.waitForSpaWebSocket();
      await app.waitForQueuedPreview(queuedB);
      await app.waitForButton('Continue queue');
      await app.waitForButton('Resume queue');
      await app.sendComposer(queuedC);
      await app.waitForText('1 of 2');
      await app.clickButton('Next queued message');
      await app.waitForQueuedPreview(queuedC);
      await app.clickButton('Previous queued message');
      await app.waitForQueuedPreview(queuedB);

      const beforeReloadConnections = await fixture.spaWebSocketConnectionCount();
      await fixture.page.reload({ waitUntil: [] });
      await fixture.waitForSpaWebSocket({ afterConnectionCount: beforeReloadConnections });
      await app.waitForQueuedPreview(queuedB);
      await app.waitForButton('Continue queue');
      await app.waitForButton('Resume queue');

      await app.clickResponsiveAction('Edit queue');
      await app.clickDialogButton('Continue queue');
      await app.waitForTextAbsent('Queue needs attention');
      expect(await app.hasButton('Continue queue')).toBe(false);
      expect(await app.hasButton('Resume queue')).toBe(true);
      expect(fixture.integration.fakeProviders.openAi.requests().map((request) => request.lastUserText)).toEqual([
        predecessor,
      ]);
      await app.clickDialogButton('Close');

      const heldB = fixture.integration.fakeProviders.openAi.holdNext({ lastUserText: queuedB });
      const heldC = fixture.integration.fakeProviders.openAi.holdNext({ lastUserText: queuedC });
      await app.clickResponsiveAction('Resume queue');
      await heldB.received;
      heldB.releaseEcho();
      await heldC.received;
      heldC.releaseEcho();
      await app.waitForText(`echo:${queuedC}`);
      expect(fixture.integration.fakeProviders.openAi.requests().filter((request) => (
        request.lastUserText === queuedB
      ))).toHaveLength(1);
      expect(fixture.integration.fakeProviders.openAi.requests().filter((request) => (
        request.lastUserText === queuedC
      ))).toHaveLength(1);
      expect((await fixture.integration.client.getExecutionControl(chatId))).toMatchObject({
        queue: { entries: [], pause: null },
        recoveredInputContinuation: null,
      });
      fixture.assertNoBrowserErrors();
    });
  }, 45_000);

  test('removes continuation from an open dialog when native reconciliation settles it', async () => {
    await withE2eFixture('native-settlement-recovered-input-continuation', async (fixture) => {
      const app = new SpaDriver(fixture.page, fixture.integration);
      const chatId = fixture.integration.newChatId();
      const predecessor = 'ui-native-recovered-predecessor';
      const queued = 'ui-native-settlement-successor';
      await restartWithNativeRecoveredInput(fixture, { chatId, predecessor, queued });

      const messagesRequestSeen = new Deferred<void>();
      const releaseMessagesRequest = new Deferred<void>();
      let interceptedMessagesRequest = false;
      const handleRequest = async (request: HTTPRequest): Promise<void> => {
        const url = new URL(request.url());
        const shouldIntercept = !interceptedMessagesRequest
          && url.pathname === '/api/v1/chats/messages'
          && url.searchParams.get('chatId') === chatId;
        if (shouldIntercept) {
          interceptedMessagesRequest = true;
          messagesRequestSeen.resolve(undefined);
          await releaseMessagesRequest.promise;
        }
        await request.continue();
      };

      await fixture.page.setRequestInterception(true);
      fixture.page.on('request', handleRequest);
      try {
        await app.openChat(chatId);
        await withTimeout(
          messagesRequestSeen.promise,
          20_000,
          () => 'SPA did not request the recovered transcript',
        );
        await fixture.waitForSpaWebSocket();
        await app.waitForQueuedPreview(queued);
        await app.waitForButton('Continue queue');
        await app.clickButton('Edit queued message');
        await fixture.page.waitForSelector('[role="dialog"]');

        const heldQueued = fixture.integration.fakeProviders.openAi.holdNext({ lastUserText: queued });
        releaseMessagesRequest.resolve(undefined);
        await heldQueued.received;
        await app.waitForTextAbsent('Queue needs attention');
        expect(await app.hasButton('Continue queue')).toBe(false);
        expect(await fixture.page.$('[role="dialog"]')).not.toBeNull();
        expect((await fixture.integration.client.getExecutionControl(chatId))).toMatchObject({
          queue: { entries: [], pause: null },
          recoveredInputContinuation: null,
        });

        heldQueued.releaseEcho();
        await app.waitForText(`echo:${queued}`);
        await app.waitForExactTextCount(predecessor, 1);
        await app.waitForExactTextCount(queued, 1);
        expect(fixture.integration.fakeProviders.openAi.requests().filter((request) => (
          request.lastUserText === queued
        ))).toHaveLength(1);
        fixture.assertNoBrowserErrors();
      } finally {
        releaseMessagesRequest.resolve(undefined);
        fixture.page.off('request', handleRequest);
        await fixture.page.setRequestInterception(false);
      }
    });
  }, 45_000);
});
