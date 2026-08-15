import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import { AssistantMessage } from '../../../common/chat-types.js';
import type { LedgerRowDraft } from '../../../server/ledger/contracts.js';
import { TranscriptLedgerStore } from '../../../server/ledger/store.js';
import { withChromiumFixture } from '../../support/chromium-fixture.js';

const FEED_SELECTOR = '[data-chat-scroll-viewport]';
const MESSAGE_SELECTOR = '[data-chat-message-type]';

interface ReplayGate {
  armed: boolean;
  events: unknown[];
  held: boolean;
  openCount: number;
  release: (() => void) | null;
  subscribeCount: number;
}

type ReplayGateScope = typeof globalThis & { __garconReplayGate?: ReplayGate };

async function installReplayGate(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const scope = globalThis as ReplayGateScope;
    const gate: ReplayGate = {
      armed: false,
      events: [],
      held: false,
      openCount: 0,
      release: null,
      subscribeCount: 0,
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
          if (gate.armed && request?.type === 'chat-subscribe') {
            gate.subscribeCount += 1;
            if (gate.subscribeCount === 2) {
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

async function armReplayGate(page: Page): Promise<void> {
  await page.evaluate(() => {
    const gate = (globalThis as ReplayGateScope).__garconReplayGate;
    if (!gate) throw new Error('Reconnect replay gate is unavailable.');
    gate.armed = true;
    gate.events = [];
    gate.held = false;
    gate.release = null;
    gate.subscribeCount = 0;
  });
}

async function waitForHeldContinuation(page: Page, previousConnections: number): Promise<void> {
  await page.waitForFunction(
    (previous) => ((globalThis as ReplayGateScope).__garconReplayGate?.openCount ?? 0) > previous,
    previousConnections,
  );
  await page.waitForFunction(
    () => (globalThis as ReplayGateScope).__garconReplayGate?.held === true,
  );
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
      await armReplayGate(fixture.page);

      const replayMarker = 'reconnect-replay-marker-450';
      markPhase('restarting with a multi-page missed range');
      await fixture.integration.crashAndRestartGarcon({
        reusePort: true,
        beforeStart: async () => {
          const store = new TranscriptLedgerStore(
            join(fixture.integration.dirs.workspace, 'transcript-ledgers'),
          );
          try {
            const view = store.currentView(chatId);
            if (!view) throw new Error('Reconnect fixture lost its transcript view.');
            store.append(chatId, view.viewId, replayRows(450, replayMarker));
          } finally {
            store.close();
          }
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
      fixture.assertNoBrowserErrors();
    });
  }, 180_000);
});
