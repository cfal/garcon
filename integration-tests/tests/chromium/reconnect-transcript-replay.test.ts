import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import { AssistantMessage } from '../../../common/chat-types.js';
import type { LedgerRowDraft } from '../../../server/ledger/contracts.js';
import { TranscriptLedgerStore } from '../../../server/ledger/store.js';
import {
  type ChromiumFixture,
  withChromiumFixture,
} from '../../support/chromium-fixture.js';

const FEED_SELECTOR = '[data-chat-scroll-viewport]';
const MESSAGE_SELECTOR = '[data-chat-message-type]';
const SIZER_SELECTOR = '[data-chat-virtual-sizer]';
const ITEM_SELECTOR = '[data-chat-virtual-item]';
const EXPECTED_RECONNECT_BROWSER_ERRORS = [
  /^console\.error: WebSocket connection to 'ws:\/\/127\.0\.0\.1:\d+\/ws\?v=\d+' failed: Error in connection establishment: net::ERR_CONNECTION_REFUSED$/,
  /^console\.error: WebSocket error: \{readyState: 3, visibilityState: visible, online: true\}$/,
  /^console\.error: Failed to load resource: net::ERR_CONNECTION_REFUSED$/,
];

interface ReplayGate {
  armed: boolean;
  events: unknown[];
  forcedStaleView: boolean;
  held: boolean;
  matchingRequests: Record<string, unknown>[];
  mode: 'force-stale-first' | 'hold-continuation' | null;
  openCount: number;
  release: (() => void) | null;
  targetChatId: string | null;
}

interface DetachedReplayAnchor {
  key: string;
  offset: number;
  rowId: string;
  text: string;
}

interface DetachedReplayFrame {
  connected: boolean;
  offset: number | null;
  rowId: string | null;
  sameNode: boolean;
  text: string | null;
}

interface DetachedReplaySampler {
  active: boolean;
  done: boolean;
  frames: DetachedReplayFrame[];
}

type ReplayGateScope = typeof globalThis & {
  __garconDetachedReplaySampler?: DetachedReplaySampler;
  __garconReplayGate?: ReplayGate;
};

async function installReplayGate(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const scope = globalThis as ReplayGateScope;
    const gate: ReplayGate = {
      armed: false,
      events: [],
      forcedStaleView: false,
      held: false,
      matchingRequests: [],
      mode: null,
      openCount: 0,
      release: null,
      targetChatId: null,
    };
    scope.__garconReplayGate = gate;
    const NativeWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = new Proxy(NativeWebSocket, {
      construct(Target, args: ConstructorParameters<typeof WebSocket>) {
        const socket = new Target(...args);
        const url = new URL(String(args[0]), globalThis.location.href);
        if (url.pathname !== '/ws') return socket;
        const send = socket.send.bind(socket);
        socket.addEventListener('open', () => {
          gate.openCount += 1;
        });
        socket.addEventListener('message', (event) => {
          try {
            gate.events.push(JSON.parse(String(event.data)));
          } catch {
            // Product code owns malformed-message handling.
          }
        });
        socket.send = (data) => {
          let request: Record<string, unknown> | null = null;
          if (typeof data === 'string') {
            try {
              const parsed = JSON.parse(data);
              request = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                ? parsed as Record<string, unknown>
                : null;
            } catch {
              request = null;
            }
          }
          if (
            gate.armed
            && request?.type === 'chat-subscribe'
            && request.chatId === gate.targetChatId
          ) {
            gate.matchingRequests.push(request);
            if (gate.mode === 'force-stale-first' && gate.matchingRequests.length === 1) {
              gate.forcedStaleView = true;
              send(JSON.stringify({
                ...request,
                transcriptViewId: `${String(request.transcriptViewId)}:forced-stale`,
              }));
              return;
            }
            if (gate.mode === 'hold-continuation' && gate.matchingRequests.length === 2) {
              gate.held = true;
              gate.release = () => {
                gate.release = null;
                send(data);
              };
              return;
            }
          }
          send(data);
        };
        return socket;
      },
    });
  });
}

async function replayGateOpenCount(page: Page): Promise<number> {
  return page.evaluate(() => (globalThis as ReplayGateScope).__garconReplayGate?.openCount ?? 0);
}

async function armReplayGate(
  page: Page,
  options: {
    chatId: string;
    mode: 'force-stale-first' | 'hold-continuation';
  },
): Promise<void> {
  await page.evaluate(({ chatId, mode }) => {
    const gate = (globalThis as ReplayGateScope).__garconReplayGate;
    if (!gate) throw new Error('Reconnect replay gate is unavailable.');
    gate.armed = true;
    gate.events = [];
    gate.forcedStaleView = false;
    gate.held = false;
    gate.matchingRequests = [];
    gate.mode = mode;
    gate.release = null;
    gate.targetChatId = chatId;
  }, options);
}

async function waitForReplayGate(
  page: Page,
  previousConnections: number,
  predicate: 'forcedStaleView' | 'held',
): Promise<void> {
  await page.waitForFunction(
    (previous) => ((globalThis as ReplayGateScope).__garconReplayGate?.openCount ?? 0) > previous,
    previousConnections,
  );
  try {
    await page.waitForFunction(
      (field) => (globalThis as ReplayGateScope).__garconReplayGate?.[field] === true,
      predicate,
    );
  } catch (error) {
    const diagnostic = await page.evaluate(() => {
      const gate = (globalThis as ReplayGateScope).__garconReplayGate;
      return gate
        ? {
            forcedStaleView: gate.forcedStaleView,
            held: gate.held,
            matchingRequests: gate.matchingRequests,
            mode: gate.mode,
            openCount: gate.openCount,
            targetChatId: gate.targetChatId,
          }
        : null;
    });
    throw new Error(
      `Reconnect replay gate did not reach ${predicate}: ${JSON.stringify(diagnostic)}`,
      { cause: error },
    );
  }
}

async function waitForHeldContinuation(page: Page, previousConnections: number): Promise<void> {
  await waitForReplayGate(page, previousConnections, 'held');
}

async function waitForForcedStaleView(page: Page, previousConnections: number): Promise<void> {
  await waitForReplayGate(page, previousConnections, 'forcedStaleView');
}

async function waitForLiveEvent(page: Page, content: string): Promise<void> {
  await page.waitForFunction(
    (expected) => ((globalThis as ReplayGateScope).__garconReplayGate?.events ?? []).some(
      (event) => (
        event !== null
        && typeof event === 'object'
        && !Array.isArray(event)
        && (event as Record<string, unknown>).type === 'chat-messages'
        && JSON.stringify(event).includes(expected)
      ),
    ),
    content,
  );
}

async function releaseHeldContinuation(page: Page): Promise<void> {
  await page.evaluate(() => {
    const release = (globalThis as ReplayGateScope).__garconReplayGate?.release;
    if (!release) throw new Error('No held reconnect continuation is available.');
    release();
  });
}

function replayRows(count: number, finalContent: string): LedgerRowDraft[] {
  return Array.from({ length: count }, (_, index) => {
    const at = new Date(Date.UTC(2026, 7, 15, 12, 0, 0, index)).toISOString();
    return {
      kind: 'provider-row',
      at,
      message: new AssistantMessage(
        at,
        index === count - 1 ? finalContent : `reconnect-replay-${index + 1}`,
      ),
      providerMeta: null,
    };
  });
}

function appendLedgerRows(
  workspace: string,
  chatId: string,
  rows: readonly LedgerRowDraft[],
): void {
  const store = new TranscriptLedgerStore(join(workspace, 'transcript-ledgers'));
  try {
    const view = store.currentView(chatId);
    if (!view) throw new Error('Reconnect fixture lost its transcript view.');
    store.append(chatId, view.viewId, rows);
  } finally {
    store.close();
  }
}

async function createLongDirectTranscript(
  fixture: ChromiumFixture,
  promptPrefix: string,
): Promise<string> {
  const chatId = fixture.integration.newChatId();
  const initial = await fixture.integration.client.startDirectChat({
    chatId,
    content: `${promptPrefix}-0`,
    projectPath: fixture.integration.dirs.project,
    agent: fixture.integration.directAgents.openAi,
  });
  await fixture.integration.client.waitForTurnTerminal(chatId, initial.turnId);
  for (let index = 1; index < 75; index += 1) {
    const turn = await fixture.integration.client.runDirectChat({
      chatId,
      content: `${promptPrefix}-${index}`,
      agent: fixture.integration.directAgents.openAi,
    });
    await fixture.integration.client.waitForTurnTerminal(chatId, turn.turnId);
  }
  return chatId;
}

function assertNoUnexpectedReconnectBrowserErrors(errors: readonly string[]): void {
  expect(errors.filter((error) => (
    !EXPECTED_RECONNECT_BROWSER_ERRORS.some((pattern) => pattern.test(error))
  ))).toEqual([]);
}

async function revealEarlierRows(page: Page): Promise<{
  expandedModelCount: number;
  initialModelCount: number;
}> {
  await page.locator(`${FEED_SELECTOR}[aria-busy="false"]`).waitFor();
  const initialModelCount = await page.locator(SIZER_SELECTOR).evaluate(async (sizerElement) => {
    const sizer = sizerElement as HTMLElement;
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    let previous = -1;
    let stableFrames = 0;
    for (let attempt = 0; attempt < 90; attempt += 1) {
      await frame();
      const current = Number(sizer.dataset.chatVirtualModelCount ?? 0);
      stableFrames = current > 0 && current === previous ? stableFrames + 1 : 0;
      previous = current;
      if (stableFrames >= 12) return current;
    }
    throw new Error('The bounded reconnect transcript did not settle.');
  });
  await page.locator(FEED_SELECTOR).focus();
  for (let press = 0; press < 32; press += 1) {
    const modelCount = await page.locator(SIZER_SELECTOR).evaluate(
      (sizer) => Number((sizer as HTMLElement).dataset.chatVirtualModelCount ?? 0),
    );
    if (modelCount > initialModelCount) break;
    await page.keyboard.press('PageUp');
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  }
  await page.waitForFunction(
    ({ selector, previous }) =>
      Number(document.querySelector<HTMLElement>(selector)?.dataset.chatVirtualModelCount ?? 0)
        > previous,
    { selector: SIZER_SELECTOR, previous: initialModelCount },
  );
  await page.locator(`${FEED_SELECTOR}[aria-busy="false"]`).waitFor();
  await page.locator(FEED_SELECTOR).evaluate(async (feedElement) => {
    const feed = feedElement as HTMLElement;
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    feed.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -1 }));
    feed.scrollTop = Math.max(1, (feed.scrollHeight - feed.clientHeight) / 2);
    feed.dispatchEvent(new Event('scroll', { bubbles: true }));
    for (let index = 0; index < 6; index += 1) await frame();
  });
  await page.waitForFunction(
    (selector) =>
      document.querySelector<HTMLElement>(selector)?.dataset.chatPinnedToBottom === 'false',
    FEED_SELECTOR,
  );
  const expandedModelCount = await page.locator(SIZER_SELECTOR).evaluate(
    (sizer) => Number((sizer as HTMLElement).dataset.chatVirtualModelCount ?? 0),
  );
  return { expandedModelCount, initialModelCount };
}

async function positionAtLoadedStart(page: Page): Promise<void> {
  await page.locator(FEED_SELECTOR).evaluate(async (feedElement) => {
    const feed = feedElement as HTMLElement;
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    feed.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -1 }));
    feed.scrollTop = 1;
    feed.dispatchEvent(new Event('scroll', { bubbles: true }));
    for (let index = 0; index < 6; index += 1) await frame();
  });
}

async function captureDetachedAnchor(page: Page): Promise<DetachedReplayAnchor> {
  return page.locator(FEED_SELECTOR).evaluate((feedElement, itemSelector) => {
    const feed = feedElement as HTMLElement;
    const viewport = feed.getBoundingClientRect();
    const wrapper = [...feed.querySelectorAll<HTMLElement>(itemSelector)].find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      return rect.bottom > viewport.top + 1
        && rect.top < viewport.bottom - 1
        && candidate.querySelector('[data-chat-row-id]');
    });
    const row = wrapper?.querySelector<HTMLElement>('[data-chat-row-id]');
    const key = wrapper?.dataset.chatVirtualItem;
    const rowId = row?.dataset.chatRowId;
    if (!wrapper || !row || !key || !rowId) {
      throw new Error('No detached reconnect reading anchor is mounted.');
    }
    return {
      key,
      offset: wrapper.getBoundingClientRect().top - viewport.top,
      rowId,
      text: row.textContent ?? '',
    };
  }, ITEM_SELECTOR);
}

async function startDetachedReplaySampler(page: Page, anchor: DetachedReplayAnchor): Promise<void> {
  await page.evaluate(({ feedSelector, itemSelector, target }) => {
    const scope = globalThis as ReplayGateScope;
    const feed = document.querySelector<HTMLElement>(feedSelector);
    const original = [...document.querySelectorAll<HTMLElement>(itemSelector)].find(
      (item) => item.dataset.chatVirtualItem === target.key,
    );
    if (!feed || !original) throw new Error('Detached replay sampler could not resolve its anchor.');
    const sampler: DetachedReplaySampler = { active: true, done: false, frames: [] };
    scope.__garconDetachedReplaySampler = sampler;
    const sample = () => {
      if (!sampler.active) {
        sampler.done = true;
        return;
      }
      const current = [...document.querySelectorAll<HTMLElement>(itemSelector)].find(
        (item) => item.dataset.chatVirtualItem === target.key,
      );
      const row = current?.querySelector<HTMLElement>('[data-chat-row-id]');
      sampler.frames.push({
        connected: current?.isConnected === true,
        offset: current ? current.getBoundingClientRect().top - feed.getBoundingClientRect().top : null,
        rowId: row?.dataset.chatRowId ?? null,
        sameNode: current === original,
        text: row?.textContent ?? null,
      });
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, { feedSelector: FEED_SELECTOR, itemSelector: ITEM_SELECTOR, target: anchor });
}

async function finishDetachedReplaySampler(page: Page): Promise<DetachedReplayFrame[]> {
  await page.evaluate(() => {
    const sampler = (globalThis as ReplayGateScope).__garconDetachedReplaySampler;
    if (!sampler) throw new Error('Detached replay sampler is unavailable.');
    sampler.active = false;
  });
  await page.waitForFunction(
    () => (globalThis as ReplayGateScope).__garconDetachedReplaySampler?.done === true,
  );
  return page.evaluate(
    () => (globalThis as ReplayGateScope).__garconDetachedReplaySampler?.frames ?? [],
  );
}

function expectStableDetachedFrames(
  frames: readonly DetachedReplayFrame[],
  anchor: DetachedReplayAnchor,
): void {
  const diagnostic = JSON.stringify({ anchor, frames }, null, 2);
  expect(frames.length, diagnostic).toBeGreaterThan(2);
  expect(frames.filter((frame) => (
    !frame.connected
    || !frame.sameNode
    || frame.offset === null
    || frame.rowId !== anchor.rowId
    || frame.text !== anchor.text
  )), diagnostic).toEqual([]);
  expect(Math.max(...frames.map((frame) => (
    frame.offset === null
      ? Number.POSITIVE_INFINITY
      : Math.abs(frame.offset - anchor.offset)
  ))), diagnostic).toBeLessThanOrEqual(1);
}

describe('Chromium reconnect transcript replay', () => {
  test('finishes a fixed replay before applying live rows without a snapshot fallback', async () => {
    await withChromiumFixture('reconnect-live-replay-order', async (fixture, markPhase) => {
      await installReplayGate(fixture.context);

      markPhase('creating the initial transcript');
      const chatId = fixture.integration.newChatId();
      const initial = await fixture.integration.client.startDirectChat({
        chatId,
        content: 'reconnect-initial',
        projectPath: fixture.integration.dirs.project,
        agent: fixture.integration.directAgents.openAi,
      });
      await fixture.integration.client.waitForTurnTerminal(chatId, initial.turnId);

      markPhase('opening the selected transcript');
      await fixture.page.goto(
        `${fixture.integration.garcon.baseUrl}/chat/${encodeURIComponent(chatId)}`,
      );
      await fixture.page.locator(FEED_SELECTOR).waitFor();
      await fixture.page.waitForFunction(
        () => ((globalThis as ReplayGateScope).__garconReplayGate?.openCount ?? 0) > 0,
      );
      await fixture.page.waitForFunction(
        (content) => document.body.textContent?.includes(content) === true,
        'echo:reconnect-initial',
      );

      const transcriptReads: string[] = [];
      fixture.page.on('request', (request) => {
        const url = new URL(request.url());
        if (url.pathname === '/api/v1/chats/messages') transcriptReads.push(url.toString());
      });
      const connectionCount = await replayGateOpenCount(fixture.page);
      await armReplayGate(fixture.page, { chatId, mode: 'hold-continuation' });

      const replayMarker = 'reconnect-replay-marker-450';
      markPhase('restarting with a multi-page missed range');
      await fixture.integration.crashAndRestartGarcon({
        reusePort: true,
        beforeStart: async () => {
          appendLedgerRows(
            fixture.integration.dirs.workspace,
            chatId,
            replayRows(450, replayMarker),
          );
        },
      });
      await waitForHeldContinuation(fixture.page, connectionCount);

      const liveContent = 'reconnect-live-during-replay';
      markPhase('publishing live rows while the continuation is held');
      const live = await fixture.integration.client.runDirectChat({
        chatId,
        content: liveContent,
        agent: fixture.integration.directAgents.openAi,
      });
      await waitForLiveEvent(fixture.page, liveContent);
      await releaseHeldContinuation(fixture.page);
      await fixture.integration.client.waitForTurnTerminal(chatId, live.turnId);

      markPhase('verifying the reconstructed live edge');
      const expectedText = [replayMarker, liveContent, `echo:${liveContent}`];
      await fixture.page.waitForFunction(
        ({ selector, values }) => {
          const text = [...document.querySelectorAll<HTMLElement>(selector)]
            .map((element) => element.textContent ?? '');
          return values.every((value) => text.filter((entry) => entry.includes(value)).length === 1);
        },
        { selector: MESSAGE_SELECTOR, values: expectedText },
      );
      const mounted = await fixture.page.evaluate(
        ({ selector, values }) => [...document.querySelectorAll<HTMLElement>(selector)]
          .map((element) => ({
            top: element.getBoundingClientRect().top,
            text: element.textContent ?? '',
          }))
          .filter((entry) => values.some((value) => entry.text.includes(value)))
          .sort((left, right) => left.top - right.top)
          .map((entry) => values.find((value) => entry.text.includes(value)) ?? null),
        { selector: MESSAGE_SELECTOR, values: expectedText },
      );
      expect(mounted).toEqual(expectedText);
      expect(transcriptReads).toEqual([]);

      const canonical = await fixture.integration.client.getMessages(chatId, { limit: 100 });
      const tail = canonical.messages.filter((entry) => (
        'content' in entry.message && expectedText.includes(String(entry.message.content))
      ));
      expect(tail.map((entry) => ({
        ordinal: entry.ordinal,
        text: 'content' in entry.message ? String(entry.message.content) : '',
      }))).toEqual([
        { ordinal: expect.any(Number), text: replayMarker },
        { ordinal: expect.any(Number), text: liveContent },
        { ordinal: expect.any(Number), text: `echo:${liveContent}` },
      ]);
      expect(tail[0]!.ordinal).toBeLessThan(tail[1]!.ordinal);
      expect(tail[1]!.ordinal).toBeLessThan(tail[2]!.ordinal);
      assertNoUnexpectedReconnectBrowserErrors(fixture.browserErrors);
    });
  }, 180_000);

  test('keeps an expanded detached reading interval through bounded reconnect replay', async () => {
    await withChromiumFixture('reconnect-detached-expanded-history', async (fixture, markPhase) => {
      await installReplayGate(fixture.context);
      await fixture.page.setViewportSize({ width: 390, height: 700 });

      markPhase('creating history beyond the bounded initial window');
      const chatId = await createLongDirectTranscript(fixture, 'detached-reconnect-history');

      markPhase('expanding and detaching the visible interval');
      await fixture.page.goto(
        `${fixture.integration.garcon.baseUrl}/chat/${encodeURIComponent(chatId)}`,
      );
      await fixture.page.locator(FEED_SELECTOR).waitFor();
      await fixture.page.waitForFunction(
        () => ((globalThis as ReplayGateScope).__garconReplayGate?.openCount ?? 0) > 0,
      );
      const { expandedModelCount, initialModelCount } = await revealEarlierRows(fixture.page);
      expect(expandedModelCount).toBeGreaterThan(initialModelCount);
      const anchor = await captureDetachedAnchor(fixture.page);
      await startDetachedReplaySampler(fixture.page, anchor);

      const connectionCount = await replayGateOpenCount(fixture.page);
      await armReplayGate(fixture.page, { chatId, mode: 'hold-continuation' });
      const replayMarker = 'detached-reconnect-final-marker';
      markPhase('replaying a multi-page missed range while detached');
      await fixture.integration.crashAndRestartGarcon({
        reusePort: true,
        beforeStart: async () => {
          appendLedgerRows(
            fixture.integration.dirs.workspace,
            chatId,
            replayRows(450, replayMarker),
          );
        },
      });
      await waitForHeldContinuation(fixture.page, connectionCount);
      await releaseHeldContinuation(fixture.page);
      await fixture.page.waitForFunction(
        ({ selector, expected }) =>
          Number(document.querySelector<HTMLElement>(selector)?.dataset.chatVirtualModelCount ?? 0)
            === expected,
        { selector: SIZER_SELECTOR, expected: expandedModelCount + 450 },
      );
      await fixture.page.locator(`${FEED_SELECTOR}[aria-busy="false"]`).waitFor();

      const frames = await finishDetachedReplaySampler(fixture.page);
      expectStableDetachedFrames(frames, anchor);

      const retainedAnchor = await captureDetachedAnchor(fixture.page);
      expect(retainedAnchor).toEqual(expect.objectContaining({
        key: anchor.key,
        rowId: anchor.rowId,
        text: anchor.text,
      }));
      expect(Math.abs(retainedAnchor.offset - anchor.offset)).toBeLessThanOrEqual(1);
      expect(await fixture.page.locator('[data-transcript-page-boundary="earlier"]').count())
        .toBe(0);

      markPhase('verifying the replayed live edge without pruning the interval');
      await fixture.page.locator(FEED_SELECTOR).evaluate(async (feedElement) => {
        const feed = feedElement as HTMLElement;
        feed.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 600 }));
        feed.scrollTop = feed.scrollHeight;
        feed.dispatchEvent(new Event('scroll', { bubbles: true }));
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      });
      await fixture.page.waitForFunction(
        ({ selector, content }) => [...document.querySelectorAll<HTMLElement>(selector)]
          .filter((element) => (element.textContent ?? '').includes(content)).length === 1,
        { selector: MESSAGE_SELECTOR, content: replayMarker },
      );
      const canonical = await fixture.integration.client.getMessages(chatId, { limit: 10 });
      expect(canonical.messages.at(-1)?.message).toMatchObject({
        type: 'assistant-message',
        content: replayMarker,
      });
      assertNoUnexpectedReconnectBrowserErrors(fixture.browserErrors);
    });
  }, 180_000);

  test('keeps an expanded detached prefix through same-view snapshot fallback', async () => {
    await withChromiumFixture('reconnect-detached-snapshot-fallback', async (fixture, markPhase) => {
      await installReplayGate(fixture.context);
      await fixture.page.setViewportSize({ width: 1280, height: 900 });

      markPhase('creating and expanding the transcript');
      const chatId = await createLongDirectTranscript(fixture, 'snapshot-fallback-history');
      await fixture.page.goto(
        `${fixture.integration.garcon.baseUrl}/chat/${encodeURIComponent(chatId)}`,
      );
      await fixture.page.locator(FEED_SELECTOR).waitFor();
      await fixture.page.waitForFunction(
        () => ((globalThis as ReplayGateScope).__garconReplayGate?.openCount ?? 0) > 0,
      );
      const { expandedModelCount, initialModelCount } = await revealEarlierRows(fixture.page);
      expect(expandedModelCount).toBeGreaterThan(initialModelCount);
      await positionAtLoadedStart(fixture.page);

      const newestPage = await fixture.integration.client.getMessages(chatId, { limit: 50 });
      const anchor = await captureDetachedAnchor(fixture.page);
      const anchorOrdinal = Number(anchor.rowId.slice(anchor.rowId.lastIndexOf(':') + 1));
      expect(anchorOrdinal).toBeLessThan(newestPage.pageOldestOrdinal);
      await startDetachedReplaySampler(fixture.page, anchor);

      const snapshotRequest = fixture.page.waitForRequest((request) => {
        if (request.method() !== 'GET') return false;
        const url = new URL(request.url());
        return url.pathname === '/api/v1/chats/messages'
          && url.searchParams.get('chatId') === chatId
          && !url.searchParams.has('beforeOrdinal');
      });
      const connectionCount = await replayGateOpenCount(fixture.page);
      await armReplayGate(fixture.page, { chatId, mode: 'force-stale-first' });

      markPhase('forcing reconnect replay into a same-view snapshot fallback');
      await fixture.integration.crashAndRestartGarcon({ reusePort: true });
      await waitForForcedStaleView(fixture.page, connectionCount);
      await snapshotRequest;
      await fixture.page.locator(`${FEED_SELECTOR}[aria-busy="false"]`).waitFor();
      await fixture.page.evaluate(async () => {
        for (let index = 0; index < 4; index += 1) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
      });

      const frames = await finishDetachedReplaySampler(fixture.page);
      expectStableDetachedFrames(frames, anchor);
      const retainedModelCount = await fixture.page.locator(SIZER_SELECTOR).evaluate(
        (sizer) => Number((sizer as HTMLElement).dataset.chatVirtualModelCount ?? 0),
      );
      expect(retainedModelCount).toBe(expandedModelCount);
      const retainedAnchor = await captureDetachedAnchor(fixture.page);
      expect(retainedAnchor).toEqual(expect.objectContaining({
        key: anchor.key,
        rowId: anchor.rowId,
        text: anchor.text,
      }));
      expect(Math.abs(retainedAnchor.offset - anchor.offset)).toBeLessThanOrEqual(1);
      assertNoUnexpectedReconnectBrowserErrors(fixture.browserErrors);
    });
  }, 180_000);
});
