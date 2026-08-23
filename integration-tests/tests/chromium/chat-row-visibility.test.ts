import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import type {
  AddChatRowResponse,
  ChatRowTargetResponse,
} from '../../../common/chat-row-contracts.js';
import type { CliPresentationStyle } from '../../../common/cli-presentation.js';
import { TranscriptLedgerStore } from '../../../server/ledger/store.js';
import {
  withChromiumFixture,
  type ChromiumFixture,
} from '../../support/chromium-fixture.js';
import { waitForPersistedChat } from '../../support/persisted-chat.js';

const FEED_SELECTOR = '[data-chat-scroll-viewport]';
const EXPECTED_RECONNECT_BROWSER_ERRORS = [
  /^console\.error: WebSocket connection to 'ws:\/\/127\.0\.0\.1:\d+\/ws\?v=\d+' failed: Error in connection establishment: net::ERR_CONNECTION_REFUSED$/,
  /^console\.error: WebSocket error: \{readyState: 3, visibilityState: visible, online: true\}$/,
  /^console\.error: Failed to load resource: net::ERR_CONNECTION_REFUSED$/,
];

interface SocketTracker {
  readonly frames: unknown[];
  openCount: number;
}

type BrowserScope = typeof globalThis & {
  __chatRowComposer?: HTMLTextAreaElement;
  __chatRowSocketTracker?: SocketTracker;
};

async function installSocketTracker(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const scope = globalThis as BrowserScope;
    const tracker: SocketTracker = { frames: [], openCount: 0 };
    scope.__chatRowSocketTracker = tracker;
    const NativeWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = new Proxy(NativeWebSocket, {
      construct(Target, arguments_) {
        const socket = new Target(...arguments_ as ConstructorParameters<typeof WebSocket>);
        const url = new URL(String(arguments_[0]), globalThis.location.href);
        if (url.pathname !== '/ws') return socket;
        socket.addEventListener('open', () => {
          tracker.openCount += 1;
        });
        socket.addEventListener('message', (event) => {
          try {
            tracker.frames.push(JSON.parse(String(event.data)));
          } catch {
            // Product code owns malformed-message handling.
          }
        });
        return socket;
      },
    });
  });
}

async function allowDirectChats(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    globalThis.localStorage.setItem(
      'pref_local_settings',
      JSON.stringify({ allowDirectChats: true }),
    );
  });
}

async function completeChat(
  fixture: ChromiumFixture,
  content: string,
): Promise<string> {
  const chatId = fixture.integration.newChatId();
  const started = await fixture.integration.client.startDirectChat({
    chatId,
    content,
    projectPath: fixture.integration.dirs.project,
    agent: fixture.integration.directAgents.openAi,
  });
  expect((await fixture.integration.client.waitForTurnTerminal(chatId, started.turnId)).type).toBe(
    'agent-run-finished',
  );
  return chatId;
}

async function chatSummaryMetadata(
  fixture: ChromiumFixture,
  chatId: string,
): Promise<{
  title: string;
  firstMessage: string | undefined;
  lastMessage: string;
  lastActivityAt: string | null;
  isUnread: boolean;
  isProcessing: boolean;
}> {
  const chat = (await fixture.integration.client.listChats()).sessions.find(
    (candidate) => candidate.id === chatId,
  );
  if (!chat) throw new Error(`Chat ${chatId} was missing from the catalog`);
  return {
    title: chat.title,
    firstMessage: chat.preview.firstMessage,
    lastMessage: chat.preview.lastMessage,
    lastActivityAt: chat.activity.lastActivityAt,
    isUnread: chat.isUnread,
    isProcessing: chat.isProcessing,
  };
}

async function waitForDurablyReadChatSummaryMetadata(
  fixture: ChromiumFixture,
  chatId: string,
): Promise<Awaited<ReturnType<typeof chatSummaryMetadata>>> {
  const initial = await chatSummaryMetadata(fixture, chatId);
  const lastActivityAt = initial.lastActivityAt;
  if (!lastActivityAt) {
    throw new Error(`Chat ${chatId} had no activity to mark read`);
  }
  await waitForPersistedChat({
    directories: fixture.integration.dirs,
    chatId,
    timeoutMs: 20_000,
    timeoutMessage: `Chat ${chatId} did not persist its read receipt`,
    select: (chat) => typeof chat.lastReadAt === 'string'
      && chat.lastReadAt >= lastActivityAt
      ? true
      : null,
  });
  const persisted = await chatSummaryMetadata(fixture, chatId);
  if (persisted.isUnread) {
    throw new Error(`Chat ${chatId} remained unread after its read receipt persisted`);
  }
  return persisted;
}

async function openChat(page: Page, baseUrl: string, chatId: string, marker: string): Promise<void> {
  await page.goto(`${baseUrl}/chat/${encodeURIComponent(chatId)}`);
  await page.locator(FEED_SELECTOR).waitFor();
  await page.locator(FEED_SELECTOR).getByText(marker, { exact: true }).waitFor();
  await page.waitForFunction(
    () => ((globalThis as BrowserScope).__chatRowSocketTracker?.openCount ?? 0) > 0,
  );
}

async function selectSidebarChat(page: Page, chatId: string, marker: string): Promise<void> {
  await page
    .locator(`[data-sidebar-virtual-row="${chatId}"]`)
    .locator('button')
    .first()
    .click();
  await page.waitForURL(new RegExp(`/chat/${chatId}$`));
  await page.locator(FEED_SELECTOR).getByText(marker, { exact: true }).waitFor();
}

async function addRow(input: {
  fixture: ChromiumFixture;
  chatId: string;
  transcriptViewId: string;
  type: CliPresentationStyle;
  title: string;
  content: string;
  identity: string;
}): Promise<AddChatRowResponse> {
  return input.fixture.integration.client.post<AddChatRowResponse>('/api/v1/chats/rows', {
    clientRequestId: `${input.identity}-request`,
    clientMessageId: `${input.identity}-message`,
    chatId: input.chatId,
    transcriptViewId: input.transcriptViewId,
    type: input.type,
    title: input.title,
    content: input.content,
  });
}

function rowLocator(page: Page, row: Pick<AddChatRowResponse, 'transcriptViewId' | 'ordinal'>) {
  return page.locator(
    `[data-chat-row-id="${row.transcriptViewId}:${row.ordinal}"]`,
  );
}

async function expectRenderedRow(
  page: Page,
  row: Pick<AddChatRowResponse, 'transcriptViewId' | 'ordinal'>,
  expected: {
    messageType: 'transcript-notice' | 'error';
    title: string;
    content: string;
    variantClass: 'border-status-info-border' | 'border-status-error-border';
  },
): Promise<void> {
  const locator = rowLocator(page, row);
  await locator.waitFor();
  expect(await locator.count()).toBe(1);
  expect(await locator.getAttribute('data-chat-message-type')).toBe(expected.messageType);
  const card = locator.locator('article.cli-row-message');
  await card.waitFor();
  expect(await card.getAttribute('class')).toContain(expected.variantClass);
  await card.getByText(expected.title, { exact: true }).waitFor();
  await card.getByText(expected.content, { exact: true }).waitFor();
  expect(await card.locator('svg[aria-hidden="true"]').count()).toBe(1);
  expect(await card.locator('button').count()).toBe(0);
  if (expected.messageType === 'error') {
    expect(await locator.getByText('Error', { exact: true }).count()).toBe(0);
  }
}

async function waitForTrackedContent(page: Page, content: string): Promise<void> {
  await page.waitForFunction(
    (expected) => JSON.stringify(
      (globalThis as BrowserScope).__chatRowSocketTracker?.frames ?? [],
    ).includes(expected),
    content,
  );
}

async function trackerSnapshot(page: Page): Promise<{ frameCount: number; openCount: number }> {
  return page.evaluate(() => {
    const tracker = (globalThis as BrowserScope).__chatRowSocketTracker;
    return {
      frameCount: tracker?.frames.length ?? 0,
      openCount: tracker?.openCount ?? 0,
    };
  });
}

async function waitForReplayRows(
  page: Page,
  afterFrame: number,
  transcriptViewId: string,
  ordinals: readonly number[],
): Promise<void> {
  await page.waitForFunction(
    ({ afterFrame, transcriptViewId, ordinals }) => (
      ((globalThis as BrowserScope).__chatRowSocketTracker?.frames ?? [])
        .slice(afterFrame)
        .some((frame) => {
          if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return false;
          const record = frame as Record<string, unknown>;
          if (
            record.type !== 'chat-subscribed'
            || record.transcriptViewId !== transcriptViewId
            || !Array.isArray(record.messages)
          ) return false;
          const replayed = new Set(record.messages.flatMap((entry) => (
            entry && typeof entry === 'object' && !Array.isArray(entry)
              && Number.isSafeInteger((entry as Record<string, unknown>).ordinal)
              ? [Number((entry as Record<string, unknown>).ordinal)]
              : []
          )));
          return ordinals.every((ordinal) => replayed.has(ordinal));
        })
    ),
    { afterFrame, transcriptViewId, ordinals },
  );
}

async function captureComposer(page: Page, value: string): Promise<void> {
  const composer = page.locator('textarea:visible');
  await composer.fill(value);
  await composer.focus();
  await page.locator(FEED_SELECTOR).evaluate((element) => {
    const feed = element as HTMLElement;
    feed.scrollTop = feed.scrollHeight;
    feed.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  await page.waitForFunction(() => {
    const feed = document.querySelector<HTMLElement>('[data-chat-scroll-viewport]');
    return Boolean(feed && Math.abs(feed.scrollHeight - feed.clientHeight - feed.scrollTop) <= 1);
  });
  await page.evaluate(() => {
    const active = document.activeElement;
    if (!(active instanceof HTMLTextAreaElement)) {
      throw new Error('The active composer is not a textarea.');
    }
    (globalThis as BrowserScope).__chatRowComposer = active;
  });
}

async function expectComposerStable(page: Page, value: string): Promise<void> {
  const snapshot = await page.evaluate(() => {
    const scope = globalThis as BrowserScope;
    const feed = document.querySelector<HTMLElement>('[data-chat-scroll-viewport]');
    return {
      distanceFromEnd: feed
        ? feed.scrollHeight - feed.clientHeight - feed.scrollTop
        : Number.POSITIVE_INFINITY,
      focused: document.activeElement === scope.__chatRowComposer,
      sameNode: scope.__chatRowComposer?.isConnected === true,
      value: scope.__chatRowComposer?.value ?? null,
    };
  });
  expect(snapshot).toEqual({
    distanceFromEnd: expect.any(Number),
    focused: true,
    sameNode: true,
    value,
  });
  expect(Math.abs(snapshot.distanceFromEnd)).toBeLessThanOrEqual(1);
}

function assertOnlyExpectedReconnectErrors(errors: readonly string[]): void {
  expect(errors.filter((error) => (
    !EXPECTED_RECONNECT_BROWSER_ERRORS.some((pattern) => pattern.test(error))
  ))).toEqual([]);
}

describe('Chromium transcript chat rows', () => {
  test('[TLV5-CHAT-ROW.06-CHROMIUM-01] updates active and background clients and replays each row exactly once', async () => {
    await withChromiumFixture('chat-row-multi-client-visibility', async (fixture, markPhase) => {
      await installSocketTracker(fixture.context);
      const observerContext = await fixture.browser.newContext({
        viewport: { width: 1440, height: 900 },
      });
      await allowDirectChats(observerContext);
      await installSocketTracker(observerContext);
      const observerPage = await observerContext.newPage();
      observerPage.setDefaultTimeout(20_000);
      observerPage.setDefaultNavigationTimeout(20_000);
      const observerErrors: string[] = [];
      observerPage.on('pageerror', (error) => observerErrors.push(`pageerror: ${error.message}`));
      observerPage.on('console', (message) => {
        if (message.type() === 'error') observerErrors.push(`console.error: ${message.text()}`);
      });

      try {
        markPhase('creating target and control transcripts');
        const targetPreview = 'echo:chat-row-browser-target';
        const targetChatId = await completeChat(fixture, 'chat-row-browser-target');
        const controlChatId = await completeChat(fixture, 'chat-row-browser-control');
        const targetPage = await fixture.integration.client.getMessages(targetChatId, {
          limit: 200,
        });
        const target = await fixture.integration.client.get<ChatRowTargetResponse>(
          `/api/v1/chats/rows?chatId=${encodeURIComponent(targetChatId)}`,
        );
        expect(target).toEqual({
          success: true,
          chatId: targetChatId,
          transcriptViewId: targetPage.transcriptViewId,
        });

        markPhase('opening independent active and background clients');
        await openChat(
          fixture.page,
          fixture.integration.garcon.baseUrl,
          targetChatId,
          targetPreview,
        );
        await openChat(
          observerPage,
          fixture.integration.garcon.baseUrl,
          targetChatId,
          targetPreview,
        );
        await selectSidebarChat(
          observerPage,
          controlChatId,
          'echo:chat-row-browser-control',
        );
        const targetSummary = observerPage.locator(
          `[data-sidebar-virtual-row="${targetChatId}"] [data-slot="sidebar-chat-summary"]`,
        );
        await targetSummary.waitFor();
        const initialTargetSummary = await waitForDurablyReadChatSummaryMetadata(
          fixture,
          targetChatId,
        );
        await captureComposer(fixture.page, 'chat row draft remains stable');

        const noticeContent = 'browser chat row notice';
        const errorContent = 'browser chat row error';
        const noticeTitle = 'Browser deployment';
        const errorTitle = 'Browser release validation';
        markPhase('publishing live notice and error chat rows');
        const notice = await addRow({
          fixture,
          chatId: targetChatId,
          transcriptViewId: target.transcriptViewId,
          type: 'notice',
          title: noticeTitle,
          content: noticeContent,
          identity: 'browser-live-notice',
        });
        const error = await addRow({
          fixture,
          chatId: targetChatId,
          transcriptViewId: target.transcriptViewId,
          type: 'error',
          title: errorTitle,
          content: errorContent,
          identity: 'browser-live-error',
        });
        expect(notice).toMatchObject({
          status: 'appended',
          transcriptViewId: target.transcriptViewId,
          type: 'notice',
        });
        expect(error).toMatchObject({
          ordinal: notice.ordinal + 1,
          status: 'appended',
          transcriptViewId: target.transcriptViewId,
          type: 'error',
        });
        await expectRenderedRow(fixture.page, notice, {
          messageType: 'transcript-notice',
          title: noticeTitle,
          content: noticeContent,
          variantClass: 'border-status-info-border',
        });
        await expectRenderedRow(fixture.page, error, {
          messageType: 'error',
          title: errorTitle,
          content: errorContent,
          variantClass: 'border-status-error-border',
        });
        await waitForTrackedContent(observerPage, noticeContent);
        await waitForTrackedContent(observerPage, errorContent);
        await waitForTrackedContent(observerPage, noticeTitle);
        await waitForTrackedContent(observerPage, errorTitle);
        await expectComposerStable(fixture.page, 'chat row draft remains stable');

        markPhase('restoring the warmed background transcript');
        await selectSidebarChat(observerPage, targetChatId, errorContent);
        await expectRenderedRow(observerPage, notice, {
          messageType: 'transcript-notice',
          title: noticeTitle,
          content: noticeContent,
          variantClass: 'border-status-info-border',
        });
        await expectRenderedRow(observerPage, error, {
          messageType: 'error',
          title: errorTitle,
          content: errorContent,
          variantClass: 'border-status-error-border',
        });
        await targetSummary.getByText(targetPreview, { exact: true }).waitFor();
        expect(await chatSummaryMetadata(fixture, targetChatId)).toEqual(initialTargetSummary);
        const liveBoxes = await Promise.all([
          rowLocator(observerPage, notice).boundingBox(),
          rowLocator(observerPage, error).boundingBox(),
        ]);
        expect(liveBoxes[0]?.y).toBeLessThan(liveBoxes[1]?.y ?? Number.NEGATIVE_INFINITY);

        const activeTracker = await trackerSnapshot(fixture.page);
        const observerTracker = await trackerSnapshot(observerPage);
        const activeTranscriptReads: string[] = [];
        const observerTranscriptReads: string[] = [];
        fixture.page.on('request', (request) => {
          if (new URL(request.url()).pathname === '/api/v1/chats/messages') {
            activeTranscriptReads.push(request.url());
          }
        });
        observerPage.on('request', (request) => {
          if (new URL(request.url()).pathname === '/api/v1/chats/messages') {
            observerTranscriptReads.push(request.url());
          }
        });

        const replayRows: {
          notice: AddChatRowResponse | null;
          error: AddChatRowResponse | null;
        } = { notice: null, error: null };
        markPhase('restarting after committing rows while both sockets are detached');
        await fixture.integration.crashAndRestartGarcon({
          reusePort: true,
          beforeStart: async () => {
            const store = new TranscriptLedgerStore(
              join(fixture.integration.dirs.workspace, 'transcript-ledgers'),
            );
            try {
              const current = store.currentView(targetChatId);
              if (current?.viewId !== target.transcriptViewId) {
                throw new Error('The restart fixture opened an unexpected transcript view.');
              }
              const noticeResult = store.appendChatRow(targetChatId, {
                viewId: current.viewId,
                at: '2026-08-18T12:00:00.000Z',
                message: 'browser replay notice',
                detail: {
                  type: 'cli-row',
                  clientMessageId: 'browser-replay-notice-message',
                  presentation: 'notice',
                  title: 'Replay deployment',
                },
              });
              const errorResult = store.appendChatRow(targetChatId, {
                viewId: current.viewId,
                at: '2026-08-18T12:00:01.000Z',
                message: 'browser replay error',
                detail: {
                  type: 'cli-row',
                  clientMessageId: 'browser-replay-error-message',
                  presentation: 'error',
                  title: 'Replay release validation',
                },
              });
              replayRows.notice = {
                success: true,
                commandType: 'chat-row-add',
                clientRequestId: 'browser-replay-notice-request',
                clientMessageId: noticeResult.row.detail.clientMessageId,
                chatId: targetChatId,
                transcriptViewId: noticeResult.row.viewId,
                ordinal: noticeResult.row.ordinal,
                type: noticeResult.row.detail.presentation,
                status: 'appended',
                timestamp: noticeResult.row.at,
              };
              replayRows.error = {
                success: true,
                commandType: 'chat-row-add',
                clientRequestId: 'browser-replay-error-request',
                clientMessageId: errorResult.row.detail.clientMessageId,
                chatId: targetChatId,
                transcriptViewId: errorResult.row.viewId,
                ordinal: errorResult.row.ordinal,
                type: errorResult.row.detail.presentation,
                status: 'appended',
                timestamp: errorResult.row.at,
              };
            } finally {
              store.close();
            }
          },
        });
        const missedNotice = replayRows.notice;
        const missedError = replayRows.error;
        if (!missedNotice || !missedError) {
          throw new Error('The restart fixture did not append both chat rows.');
        }
        expect(missedError.ordinal).toBe(missedNotice.ordinal + 1);

        markPhase('verifying fixed-watermark replay and exact-once rendering');
        await fixture.page.waitForFunction(
          (previous) => (
            ((globalThis as BrowserScope).__chatRowSocketTracker?.openCount ?? 0) > previous
          ),
          activeTracker.openCount,
        );
        await observerPage.waitForFunction(
          (previous) => (
            ((globalThis as BrowserScope).__chatRowSocketTracker?.openCount ?? 0) > previous
          ),
          observerTracker.openCount,
        );
        await waitForReplayRows(
          fixture.page,
          activeTracker.frameCount,
          target.transcriptViewId,
          [missedNotice.ordinal, missedError.ordinal],
        );
        await waitForReplayRows(
          observerPage,
          observerTracker.frameCount,
          target.transcriptViewId,
          [missedNotice.ordinal, missedError.ordinal],
        );
        await expectRenderedRow(
          fixture.page,
          missedNotice,
          {
            messageType: 'transcript-notice',
            title: 'Replay deployment',
            content: 'browser replay notice',
            variantClass: 'border-status-info-border',
          },
        );
        await expectRenderedRow(fixture.page, missedError, {
          messageType: 'error',
          title: 'Replay release validation',
          content: 'browser replay error',
          variantClass: 'border-status-error-border',
        });
        await expectRenderedRow(
          observerPage,
          missedNotice,
          {
            messageType: 'transcript-notice',
            title: 'Replay deployment',
            content: 'browser replay notice',
            variantClass: 'border-status-info-border',
          },
        );
        await expectRenderedRow(observerPage, missedError, {
          messageType: 'error',
          title: 'Replay release validation',
          content: 'browser replay error',
          variantClass: 'border-status-error-border',
        });
        for (const page of [fixture.page, observerPage]) {
          for (const row of [notice, error, missedNotice, missedError]) {
            expect(await rowLocator(page, row).count()).toBe(1);
          }
        }
        expect(activeTranscriptReads).toEqual([]);
        expect(observerTranscriptReads).toEqual([]);
        await expectComposerStable(fixture.page, 'chat row draft remains stable');

        const canonical = await fixture.integration.client.getMessages(targetChatId, {
          limit: 200,
        });
        expect(canonical.messages.filter((entry) => (
          [notice.ordinal, error.ordinal, missedNotice.ordinal, missedError.ordinal]
            .includes(entry.ordinal)
        )).map((entry) => ({
          ordinal: entry.ordinal,
          type: entry.message.type,
          content: 'content' in entry.message ? entry.message.content : null,
          title: 'title' in entry.message ? entry.message.title : undefined,
          detail: 'detail' in entry.message ? entry.message.detail : undefined,
        }))).toEqual([
          {
            ordinal: notice.ordinal,
            type: 'transcript-notice',
            content: noticeContent,
            title: noticeTitle,
            detail: { type: 'cli-row' },
          },
          {
            ordinal: error.ordinal,
            type: 'error',
            content: errorContent,
            title: errorTitle,
            detail: { type: 'cli-row' },
          },
          {
            ordinal: missedNotice.ordinal,
            type: 'transcript-notice',
            content: 'browser replay notice',
            title: 'Replay deployment',
            detail: { type: 'cli-row' },
          },
          {
            ordinal: missedError.ordinal,
            type: 'error',
            content: 'browser replay error',
            title: 'Replay release validation',
            detail: { type: 'cli-row' },
          },
        ]);
        await targetSummary.getByText(targetPreview, { exact: true }).waitFor();
        expect(await chatSummaryMetadata(fixture, targetChatId)).toEqual(initialTargetSummary);
        assertOnlyExpectedReconnectErrors(fixture.browserErrors);
        assertOnlyExpectedReconnectErrors(observerErrors);
      } finally {
        await observerContext.close();
      }
    });
  }, 180_000);
});
