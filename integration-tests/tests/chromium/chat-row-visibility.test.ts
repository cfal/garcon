import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import type {
  AddChatRowResponse,
  ChatRowTargetResponse,
} from '../../../common/chat-row-contracts.js';
import type { UserMessagePresentation } from '../../../common/chat-types.js';
import type {
  CliBodyDisclosure,
  CliPresentation,
  CliRowFormat,
} from '../../../common/cli-presentation.js';
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
  userMessagePresentation?: UserMessagePresentation,
): Promise<string> {
  const chatId = fixture.integration.newChatId();
  const request = fixture.integration.client.directStartRequest({
    chatId,
    content,
    projectPath: fixture.integration.dirs.project,
    agent: fixture.integration.directAgents.openAi,
  });
  const started = await fixture.integration.client.startChat({
    ...request,
    ...(userMessagePresentation === undefined ? {} : { userMessagePresentation }),
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
  presentation: CliPresentation;
  format?: CliRowFormat;
  disclosure?: CliBodyDisclosure;
  title: string;
  content: string;
  identity: string;
}): Promise<AddChatRowResponse> {
  return input.fixture.integration.client.post<AddChatRowResponse>('/api/v1/chats/rows', {
    clientRequestId: `${input.identity}-request`,
    clientMessageId: `${input.identity}-message`,
    chatId: input.chatId,
    transcriptViewId: input.transcriptViewId,
    presentation: input.presentation,
    format: input.format ?? 'plain',
    disclosure: input.disclosure ?? 'expanded',
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
    messageType: 'cli-row';
    title: string;
    content: string;
    variantClass:
      | 'border-status-info-border'
      | 'border-status-error-border'
      | 'border-status-neutral-border';
    customStyle?: {
      lightAccent: string;
      darkAccent: string;
    };
    markdownStrongText?: string;
    collapsed?: boolean;
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
  if (expected.customStyle) {
    expect(await card.getAttribute('class')).toContain('cli-row-message-custom');
    expect(await card.getAttribute('class')).toContain('cli-presentation-custom');
    const customStyleContainer = card.locator('..');
    const inlineStyle = await customStyleContainer.getAttribute('style');
    expect(inlineStyle).toContain(
      `--cli-presentation-accent-light: ${expected.customStyle.lightAccent}`,
    );
    expect(inlineStyle).toContain(
      `--cli-presentation-accent-dark: ${expected.customStyle.darkAccent}`,
    );
  }
  if (expected.markdownStrongText) {
    await card.locator('strong').getByText(expected.markdownStrongText, { exact: true }).waitFor();
  }
  expect(await card.locator('svg[aria-hidden="true"]').count()).toBe(1);
  const disclosureButton = card.getByRole('button', {
    name: expected.collapsed ? 'Show more' : 'Show less',
  });
  if (expected.collapsed) {
    expect(await disclosureButton.getAttribute('aria-expanded')).toBe('false');
  } else {
    expect(await card.locator('button').count()).toBe(0);
  }
  expect(await locator.getByText('Error', { exact: true }).count()).toBe(0);
}

async function cardColors(
  page: Page,
  row: Pick<AddChatRowResponse, 'transcriptViewId' | 'ordinal'>,
): Promise<{ border: string; background: string }> {
  return rowLocator(page, row).locator('article.cli-row-message').evaluate((element) => {
    const style = getComputedStyle(element);
    return { border: style.borderColor, background: style.backgroundColor };
  });
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
        const targetChatId = await completeChat(
          fixture,
          'chat-row-browser-target',
          {
            origin: 'cli',
            style: 'custom',
            customStyle: {
              lightAccent: '#0ea5e9',
              darkAccent: '#7dd3fc',
            },
            title: 'Browser CLI prompt',
          },
        );
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
        const presentedUserBubble = fixture.page.locator(
          '[data-user-message-presentation="custom"]',
        );
        await presentedUserBubble.waitFor();
        await presentedUserBubble.getByText('Browser CLI prompt', { exact: true }).waitFor();
        expect(await presentedUserBubble.getAttribute('class')).toContain(
          'cli-presentation-custom',
        );
        const presentedUserColors = await presentedUserBubble.evaluate((element) => {
          const style = getComputedStyle(element);
          return {
            background: style.backgroundColor,
            border: style.borderColor,
            lightAccent: style.getPropertyValue('--cli-presentation-accent-light').trim(),
            darkAccent: style.getPropertyValue('--cli-presentation-accent-dark').trim(),
          };
        });
        expect(presentedUserColors.lightAccent).toBe('#0ea5e9');
        expect(presentedUserColors.darkAccent).toBe('#7dd3fc');

        const ordinaryUserBubble = observerPage.locator('.user-message-context-target').first();
        await ordinaryUserBubble.waitFor();
        expect(await ordinaryUserBubble.getAttribute('data-user-message-presentation')).toBeNull();
        const ordinaryUserColors = await ordinaryUserBubble.evaluate((element) => {
          const style = getComputedStyle(element);
          return { background: style.backgroundColor, border: style.borderColor };
        });
        expect(presentedUserColors).not.toMatchObject(ordinaryUserColors);
        const targetSummary = observerPage.locator(
          `[data-sidebar-virtual-row="${targetChatId}"] [data-slot="sidebar-chat-summary"]`,
        );
        await targetSummary.waitFor();
        const initialTargetSummary = await waitForDurablyReadChatSummaryMetadata(
          fixture,
          targetChatId,
        );
        await captureComposer(fixture.page, 'chat row draft remains stable');

        const infoContent = 'browser chat row information';
        const noticeContent = 'browser chat row notice';
        const errorContent = 'browser chat row error';
        const customContent = [
          '**browser custom deployment**',
          ...Array.from({ length: 18 }, (_, index) => `collapsed detail ${index + 1}`),
        ].join('\n\n');
        const customRenderedContent = 'browser custom deployment';
        const infoTitle = 'Browser consultation status';
        const noticeTitle = 'Browser deployment';
        const errorTitle = 'Browser release validation';
        const customTitle = 'Browser custom deployment';
        markPhase('publishing live preset and custom chat rows');
        const info = await addRow({
          fixture,
          chatId: targetChatId,
          transcriptViewId: target.transcriptViewId,
          presentation: { style: 'info' },
          title: infoTitle,
          content: infoContent,
          identity: 'browser-live-info',
        });
        const notice = await addRow({
          fixture,
          chatId: targetChatId,
          transcriptViewId: target.transcriptViewId,
          presentation: { style: 'notice' },
          title: noticeTitle,
          content: noticeContent,
          identity: 'browser-live-notice',
        });
        const error = await addRow({
          fixture,
          chatId: targetChatId,
          transcriptViewId: target.transcriptViewId,
          presentation: { style: 'error' },
          title: errorTitle,
          content: errorContent,
          identity: 'browser-live-error',
        });
        const custom = await addRow({
          fixture,
          chatId: targetChatId,
          transcriptViewId: target.transcriptViewId,
          presentation: {
            style: 'custom',
            customStyle: {
              lightAccent: '#7c3aed',
              darkAccent: '#c4b5fd',
            },
          },
          format: 'markdown',
          disclosure: 'collapsed',
          title: customTitle,
          content: customContent,
          identity: 'browser-live-custom',
        });
        expect(info).toMatchObject({
          status: 'appended',
          transcriptViewId: target.transcriptViewId,
          presentation: { style: 'info' },
          format: 'plain',
        });
        expect(notice).toMatchObject({
          ordinal: info.ordinal + 1,
          status: 'appended',
          transcriptViewId: target.transcriptViewId,
          presentation: { style: 'notice' },
          format: 'plain',
        });
        expect(error).toMatchObject({
          ordinal: notice.ordinal + 1,
          status: 'appended',
          transcriptViewId: target.transcriptViewId,
          presentation: { style: 'error' },
          format: 'plain',
        });
        expect(custom).toMatchObject({
          ordinal: error.ordinal + 1,
          status: 'appended',
          transcriptViewId: target.transcriptViewId,
          presentation: {
            style: 'custom',
            customStyle: {
              lightAccent: '#7c3aed',
              darkAccent: '#c4b5fd',
            },
          },
          format: 'markdown',
          disclosure: 'collapsed',
        });
        await expectRenderedRow(fixture.page, info, {
          messageType: 'cli-row',
          title: infoTitle,
          content: infoContent,
          variantClass: 'border-status-neutral-border',
        });
        await expectRenderedRow(fixture.page, notice, {
          messageType: 'cli-row',
          title: noticeTitle,
          content: noticeContent,
          variantClass: 'border-status-info-border',
        });
        await expectRenderedRow(fixture.page, error, {
          messageType: 'cli-row',
          title: errorTitle,
          content: errorContent,
          variantClass: 'border-status-error-border',
        });
        await expectRenderedRow(fixture.page, custom, {
          messageType: 'cli-row',
          title: customTitle,
          content: customRenderedContent,
          variantClass: 'border-status-neutral-border',
          customStyle: {
            lightAccent: '#7c3aed',
            darkAccent: '#c4b5fd',
          },
          markdownStrongText: customRenderedContent,
          collapsed: true,
        });
        const collapsedBodyBox = await rowLocator(fixture.page, custom)
          .locator('.cli-collapsible-body-collapsed')
          .boundingBox();
        expect(collapsedBodyBox).not.toBeNull();
        expect(collapsedBodyBox!.height).toBeLessThanOrEqual(160);
        await rowLocator(fixture.page, custom)
          .getByRole('button', { name: 'Show more' })
          .evaluate((button: HTMLButtonElement) => button.click());
        await rowLocator(fixture.page, custom).getByRole('button', { name: 'Show less' }).waitFor();
        await fixture.page.waitForFunction(() => {
          const feed = document.querySelector<HTMLElement>('[data-chat-scroll-viewport]');
          return Boolean(feed && Math.abs(feed.scrollHeight - feed.clientHeight - feed.scrollTop) <= 1);
        });
        expect(await cardColors(fixture.page, custom)).not.toEqual(
          await cardColors(fixture.page, info),
        );
        await waitForTrackedContent(observerPage, infoContent);
        await waitForTrackedContent(observerPage, noticeContent);
        await waitForTrackedContent(observerPage, errorContent);
        await waitForTrackedContent(observerPage, customRenderedContent);
        await waitForTrackedContent(observerPage, infoTitle);
        await waitForTrackedContent(observerPage, noticeTitle);
        await waitForTrackedContent(observerPage, errorTitle);
        await waitForTrackedContent(observerPage, customTitle);
        await expectComposerStable(fixture.page, 'chat row draft remains stable');

        markPhase('restoring the warmed background transcript');
        await selectSidebarChat(observerPage, targetChatId, customRenderedContent);
        await expectRenderedRow(observerPage, info, {
          messageType: 'cli-row',
          title: infoTitle,
          content: infoContent,
          variantClass: 'border-status-neutral-border',
        });
        await expectRenderedRow(observerPage, notice, {
          messageType: 'cli-row',
          title: noticeTitle,
          content: noticeContent,
          variantClass: 'border-status-info-border',
        });
        await expectRenderedRow(observerPage, error, {
          messageType: 'cli-row',
          title: errorTitle,
          content: errorContent,
          variantClass: 'border-status-error-border',
        });
        await expectRenderedRow(observerPage, custom, {
          messageType: 'cli-row',
          title: customTitle,
          content: customRenderedContent,
          variantClass: 'border-status-neutral-border',
          customStyle: {
            lightAccent: '#7c3aed',
            darkAccent: '#c4b5fd',
          },
          markdownStrongText: customRenderedContent,
          collapsed: true,
        });
        await targetSummary.getByText(targetPreview, { exact: true }).waitFor();
        expect(await chatSummaryMetadata(fixture, targetChatId)).toEqual(initialTargetSummary);
        const liveBoxes = await Promise.all([
          rowLocator(observerPage, info).boundingBox(),
          rowLocator(observerPage, notice).boundingBox(),
          rowLocator(observerPage, error).boundingBox(),
          rowLocator(observerPage, custom).boundingBox(),
        ]);
        expect(liveBoxes[0]?.y).toBeLessThan(liveBoxes[1]?.y ?? Number.NEGATIVE_INFINITY);
        expect(liveBoxes[1]?.y).toBeLessThan(liveBoxes[2]?.y ?? Number.NEGATIVE_INFINITY);
        expect(liveBoxes[2]?.y).toBeLessThan(liveBoxes[3]?.y ?? Number.NEGATIVE_INFINITY);

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
                  presentation: { style: 'notice' },
                  format: 'plain',
                  disclosure: 'expanded',
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
                  presentation: { style: 'error' },
                  format: 'plain',
                  disclosure: 'expanded',
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
                presentation: noticeResult.row.detail.presentation,
                format: noticeResult.row.detail.format,
                disclosure: noticeResult.row.detail.disclosure,
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
                presentation: errorResult.row.detail.presentation,
                format: errorResult.row.detail.format,
                disclosure: errorResult.row.detail.disclosure,
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
            messageType: 'cli-row',
            title: 'Replay deployment',
            content: 'browser replay notice',
            variantClass: 'border-status-info-border',
          },
        );
        await expectRenderedRow(fixture.page, missedError, {
          messageType: 'cli-row',
          title: 'Replay release validation',
          content: 'browser replay error',
          variantClass: 'border-status-error-border',
        });
        await expectRenderedRow(
          observerPage,
          missedNotice,
          {
            messageType: 'cli-row',
            title: 'Replay deployment',
            content: 'browser replay notice',
            variantClass: 'border-status-info-border',
          },
        );
        await expectRenderedRow(observerPage, missedError, {
          messageType: 'cli-row',
          title: 'Replay release validation',
          content: 'browser replay error',
          variantClass: 'border-status-error-border',
        });
        for (const page of [fixture.page, observerPage]) {
          for (const row of [info, notice, error, custom, missedNotice, missedError]) {
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
          [
            info.ordinal,
            notice.ordinal,
            error.ordinal,
            custom.ordinal,
            missedNotice.ordinal,
            missedError.ordinal,
          ]
            .includes(entry.ordinal)
        )).map((entry) => ({
          ordinal: entry.ordinal,
          type: entry.message.type,
          content: 'content' in entry.message ? entry.message.content : null,
          title: 'title' in entry.message ? entry.message.title : undefined,
          presentation: 'presentation' in entry.message ? entry.message.presentation : undefined,
          format: 'format' in entry.message ? entry.message.format : undefined,
          disclosure: 'disclosure' in entry.message ? entry.message.disclosure : undefined,
        }))).toEqual([
          {
            ordinal: info.ordinal,
            type: 'cli-row',
            content: infoContent,
            title: infoTitle,
            presentation: { style: 'info' },
            format: 'plain',
            disclosure: 'expanded',
          },
          {
            ordinal: notice.ordinal,
            type: 'cli-row',
            content: noticeContent,
            title: noticeTitle,
            presentation: { style: 'notice' },
            format: 'plain',
            disclosure: 'expanded',
          },
          {
            ordinal: error.ordinal,
            type: 'cli-row',
            content: errorContent,
            title: errorTitle,
            presentation: { style: 'error' },
            format: 'plain',
            disclosure: 'expanded',
          },
          {
            ordinal: custom.ordinal,
            type: 'cli-row',
            content: customContent,
            title: customTitle,
            presentation: {
              style: 'custom',
              customStyle: {
                lightAccent: '#7c3aed',
                darkAccent: '#c4b5fd',
              },
            },
            format: 'markdown',
            disclosure: 'collapsed',
          },
          {
            ordinal: missedNotice.ordinal,
            type: 'cli-row',
            content: 'browser replay notice',
            title: 'Replay deployment',
            presentation: { style: 'notice' },
            format: 'plain',
            disclosure: 'expanded',
          },
          {
            ordinal: missedError.ordinal,
            type: 'cli-row',
            content: 'browser replay error',
            title: 'Replay release validation',
            presentation: { style: 'error' },
            format: 'plain',
            disclosure: 'expanded',
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
