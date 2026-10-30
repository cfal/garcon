import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import type { Page } from 'playwright';
import {
  type ChromiumFixture,
  withChromiumFixture,
} from '../../support/chromium-fixture.js';

const FEED_SELECTOR = '[data-chat-scroll-viewport]';
const MESSAGE_SELECTOR = '[data-chat-message-type]';
const TURNS_PER_CHAT = 40;
// Deterministic synthetic padding so history pages carry a realistic payload.
const PADDING = ' lorem-ipsum-synthetic-padding'.repeat(8);

interface HistoryRead {
  readonly chatId: string;
  readonly path: string;
  readonly bytes: number;
  readonly messages: number;
}

interface ReplayResponse {
  readonly chatId: string;
  readonly bytes: number;
  readonly messages: number;
  readonly firstOrdinal: number;
  readonly throughOrdinal: number;
}

// Observes transcript traffic in both directions and can withhold live transcript bodies for
// one chat, the way a server that only delivers on-screen chats would.
class TranscriptTraffic {
  historyReads: HistoryRead[] = [];
  replayRequests: Record<string, unknown>[] = [];
  replayResponses: ReplayResponse[] = [];
  withheldChatId: string | null = null;
  withheldBatches = 0;
  withheldThroughOrdinal = 0;

  reset(): void {
    this.historyReads = [];
    this.replayRequests = [];
    this.replayResponses = [];
  }

  forChat(chatId: string) {
    return {
      historyReads: this.historyReads.filter((read) => read.chatId === chatId),
      replayRequests: this.replayRequests.filter((request) => request.chatId === chatId),
      replayResponses: this.replayResponses.filter((response) => response.chatId === chatId),
    };
  }

  async install(page: Page): Promise<void> {
    page.on('response', async (response) => {
      const url = new URL(response.url());
      if (url.pathname !== '/api/v1/chats/messages' && url.pathname !== '/api/v1/chats/snapshot') return;
      const body = await response.body().catch(() => null);
      if (!body) return;
      const parsed = JSON.parse(body.toString('utf8')) as { messages?: unknown[] };
      this.historyReads.push({
        chatId: url.searchParams.get('chatId') ?? '',
        path: `${url.pathname}?${url.searchParams}`,
        bytes: body.byteLength,
        messages: parsed.messages?.length ?? 0,
      });
    });
    await page.routeWebSocket(/\/ws(?:\?|$)/, (route) => {
      const server = route.connectToServer();
      route.onMessage((message) => {
        const text = typeof message === 'string' ? message : message.toString('utf8');
        const parsed = JSON.parse(text) as Record<string, unknown>;
        if (parsed.type === 'chat-subscribe') this.replayRequests.push(parsed);
        server.send(message);
      });
      server.onMessage((message) => {
        const text = typeof message === 'string' ? message : message.toString('utf8');
        const parsed = JSON.parse(text) as Record<string, unknown>;
        if (parsed.type === 'chat-messages' && parsed.chatId === this.withheldChatId) {
          this.withheldBatches += 1;
          this.withheldThroughOrdinal = Math.max(this.withheldThroughOrdinal, Number(parsed.lastOrdinal));
          return;
        }
        if (parsed.type === 'chat-subscribed') {
          this.replayResponses.push({
            chatId: String(parsed.chatId),
            bytes: Buffer.byteLength(text, 'utf8'),
            messages: Array.isArray(parsed.messages) ? parsed.messages.length : 0,
            firstOrdinal: Number(parsed.firstOrdinal),
            throughOrdinal: Number(parsed.throughOrdinal),
          });
        }
        route.send(message);
      });
    });
  }
}

async function createChat(fixture: ChromiumFixture, label: string): Promise<string> {
  const { client, directAgents, dirs } = fixture.integration;
  const chatId = fixture.integration.newChatId();
  const started = await client.startDirectChat({
    chatId,
    content: `${label}-0${PADDING}`,
    projectPath: dirs.project,
    agent: directAgents.openAi,
  });
  await client.waitForTurnTerminal(chatId, started.turnId);
  for (let index = 1; index < TURNS_PER_CHAT; index += 1) {
    const turn = await client.runDirectChat({
      chatId,
      content: `${label}-${index}${PADDING}`,
      agent: directAgents.openAi,
    });
    await client.waitForTurnTerminal(chatId, turn.turnId);
  }
  await client.waitForProcessing(chatId, false);
  return chatId;
}

async function selectChat(page: Page, label: string, chatId: string): Promise<void> {
  await page
    .locator('[data-slot="sidebar-chat-summary"]')
    .filter({ hasText: label })
    .first()
    .locator('xpath=ancestor::button[1]')
    .click();
  await page.waitForURL((url) => url.pathname === `/chat/${chatId}`);
  await browserExpect(page.locator(FEED_SELECTOR)).toContainText(`echo:${label}-${TURNS_PER_CHAT - 1}`);
}

// A catch-up that the server could not prove contiguous would fall back to HTTP after its
// replay answer, so the window stays open briefly after that answer arrives.
async function settleActivation(page: Page, traffic: TranscriptTraffic, chatId: string): Promise<void> {
  await browserExpect
    .poll(() => traffic.forChat(chatId).replayResponses.length + traffic.forChat(chatId).historyReads.length)
    .toBeGreaterThan(0);
  await page.waitForTimeout(750);
}

async function messageTexts(page: Page): Promise<string[]> {
  return page.locator(MESSAGE_SELECTOR).evaluateAll((elements) =>
    elements.map((element) => (element.textContent ?? '').trim()));
}

async function isPinnedToBottom(page: Page): Promise<boolean> {
  return page.locator(FEED_SELECTOR).evaluate(
    (element) => element.scrollHeight - element.scrollTop - element.clientHeight < 4,
  );
}

type RowMatcher = (text: string) => boolean;

const row = (value: string): RowMatcher => (text) => text === value;
// The first turn after an agent switch echoes the carried context the new agent received.
const reboundEcho: RowMatcher = (text) => text.startsWith('echo:') && text.endsWith('warm-alpha-rebound');

// Each tail row renders once, after the last row the cache held, and in ledger order.
function expectContiguousTail(texts: string[], tail: readonly RowMatcher[]): void {
  const cachedEdge = texts.findLastIndex((text) => text.startsWith(`echo:warm-alpha-${TURNS_PER_CHAT - 1} `));
  expect(cachedEdge).toBeGreaterThanOrEqual(0);
  const positions = tail.map((matches) => {
    expect(texts.filter(matches)).toHaveLength(1);
    return texts.findIndex(matches);
  });
  expect(positions[0]).toBeGreaterThan(cachedEdge);
  expect(positions).toEqual([...positions].sort((left, right) => left - right));
}

function summarize(traffic: Pick<TranscriptTraffic, 'historyReads' | 'replayRequests' | 'replayResponses'>) {
  return {
    historyReads: traffic.historyReads.length,
    historyBytes: traffic.historyReads.reduce((total, read) => total + read.bytes, 0),
    historyMessages: traffic.historyReads.reduce((total, read) => total + read.messages, 0),
    replayRequests: traffic.replayRequests.length,
    replayBytes: traffic.replayResponses.reduce((total, response) => total + response.bytes, 0),
    replayMessages: traffic.replayResponses.reduce((total, response) => total + response.messages, 0),
  };
}

test('[TLV5-REPLAY.08-CHROMIUM-01] resumes cached chats from their ledger cursor across A to B to A switches', async () => {
  await withChromiumFixture('warm-chat-activation', async (fixture, phase) => {
    const { page, integration } = fixture;
    const traffic = new TranscriptTraffic();
    await traffic.install(page);
    await page.setViewportSize({ width: 1440, height: 900 });

    phase('creating two long synthetic transcripts');
    const alpha = await createChat(fixture, 'warm-alpha');
    const beta = await createChat(fixture, 'warm-beta');

    phase('opening both chats once');
    await page.goto(`${integration.garcon.baseUrl}/chat/${alpha}`);
    await browserExpect(page.locator(FEED_SELECTOR)).toContainText(`echo:warm-alpha-${TURNS_PER_CHAT - 1}`);
    await selectChat(page, 'warm-beta', beta);
    await settleActivation(page, traffic, beta);
    await selectChat(page, 'warm-alpha', alpha);
    await settleActivation(page, traffic, alpha);

    phase('measuring a warm A to B to A cycle');
    const alphaHead = (await integration.client.getMessages(alpha, { limit: 1 })).lastOrdinal;
    const betaHead = (await integration.client.getMessages(beta, { limit: 1 })).lastOrdinal;
    traffic.reset();
    await selectChat(page, 'warm-beta', beta);
    await settleActivation(page, traffic, beta);
    await selectChat(page, 'warm-alpha', alpha);
    await settleActivation(page, traffic, alpha);
    const warmCycle = { ...summarize(traffic), alphaHead, betaHead };
    console.info('Warm chat activation A to B to A traffic', JSON.stringify(warmCycle));
    const warmAlpha = traffic.forChat(alpha);
    expect(warmCycle.historyReads).toBe(0);
    expect(warmAlpha.replayRequests).toEqual([
      expect.objectContaining({ afterOrdinal: alphaHead, transcriptViewId: expect.any(String), purpose: 'activation' }),
    ]);
    expect(warmAlpha.replayResponses).toEqual([
      expect.objectContaining({ messages: 0, firstOrdinal: alphaHead + 1, throughOrdinal: alphaHead }),
    ]);
    expect(traffic.forChat(beta).replayRequests).toEqual([
      expect.objectContaining({ afterOrdinal: betaHead, purpose: 'activation' }),
    ]);
    expect(await isPinnedToBottom(page)).toBe(true);

    phase('advancing A while it is offscreen and its live rows are withheld');
    await selectChat(page, 'warm-beta', beta);
    await settleActivation(page, traffic, beta);
    traffic.withheldChatId = alpha;
    const missed = await integration.client.runDirectChat({
      chatId: alpha,
      content: 'warm-alpha-missed',
      agent: integration.directAgents.openAi,
    });
    await integration.client.waitForTurnTerminal(alpha, missed.turnId);
    const rebound = await integration.client.handoffDirectChat({
      chatId: alpha,
      content: 'warm-alpha-rebound',
      agent: integration.directAgents.anthropic,
    });
    await integration.client.waitForTurnTerminal(alpha, rebound.turnId);
    await integration.client.waitForProcessing(alpha, false);
    const staleHead = (await integration.client.getMessages(alpha, { limit: 1 })).lastOrdinal;
    expect(staleHead).toBeGreaterThan(alphaHead);
    // A row delivered after withholding ends would arrive with a gap and correctly force a
    // snapshot, so every row through the head must be withheld before A returns.
    await browserExpect.poll(() => traffic.withheldThroughOrdinal).toBe(staleHead);

    phase('returning to the stale cached chat');
    traffic.withheldChatId = null;
    traffic.reset();
    await selectChat(page, 'warm-alpha', alpha);
    await browserExpect.poll(async () => (await messageTexts(page)).some(reboundEcho)).toBe(true);
    await settleActivation(page, traffic, alpha);
    const staleAlpha = traffic.forChat(alpha);
    console.info(
      'Stale cached chat return traffic',
      JSON.stringify({ ...summarize(staleAlpha), alphaHead, staleHead }),
    );
    expect(staleAlpha.historyReads).toEqual([]);
    expect(staleAlpha.replayRequests).toEqual([
      expect.objectContaining({ afterOrdinal: alphaHead, purpose: 'activation' }),
    ]);
    expect(staleAlpha.replayResponses).toEqual([
      expect.objectContaining({ firstOrdinal: alphaHead + 1, throughOrdinal: staleHead }),
    ]);
    expect(staleAlpha.replayResponses[0]!.messages).toBeGreaterThanOrEqual(4);
    const tail = [
      row('warm-alpha-missed'),
      row('echo:warm-alpha-missed'),
      row('warm-alpha-rebound'),
      reboundEcho,
    ];
    expectContiguousTail(await messageTexts(page), tail);
    expect(await isPinnedToBottom(page)).toBe(true);

    phase('applying the next live rows after the caught-up cursor');
    traffic.reset();
    const live = await integration.client.runDirectChat({
      chatId: alpha,
      content: 'warm-alpha-live',
      agent: integration.directAgents.anthropic,
    });
    await integration.client.waitForTurnTerminal(alpha, live.turnId);
    await browserExpect(page.locator(FEED_SELECTOR)).toContainText('echo:warm-alpha-live');
    expectContiguousTail(
      await messageTexts(page),
      [...tail, row('warm-alpha-live'), row('echo:warm-alpha-live')],
    );
    expect(traffic.historyReads).toEqual([]);
    expect(traffic.replayRequests).toEqual([]);
    fixture.assertNoBrowserErrors();
  });
}, 240_000);
