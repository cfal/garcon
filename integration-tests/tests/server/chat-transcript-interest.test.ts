import { describe, expect, test } from 'bun:test';
import { applyTranscriptAppend, type TranscriptMessage } from '../../../common/chat-view.js';
import type { ChatMessagesMessage } from '../../../common/ws-events.js';
import type { ChatTranscriptAdvancedMessage } from '../../../common/ws-transcript-summary.js';
import { summarizeTranscriptActivity } from '../../../common/chat-transcript-activity.js';
import type { PrimaryWsServerMessage as ServerWsMessage } from '../../../common/ws-protocol.js';
import type { GarconTestClient } from '../../support/garcon-client.js';
import { withIntegrationFixture, type IntegrationFixture } from '../../support/integration-fixture.js';

// Each case runs several provider turns, which outlast the default suite timeout.
const TEST_TIMEOUT_MS = 120_000;

type TranscriptSpan = Pick<ChatMessagesMessage, 'firstOrdinal' | 'lastOrdinal' | 'messages'>;

function bodiesFor(events: readonly ServerWsMessage[], chatId: string): ChatMessagesMessage[] {
  return events.filter((event): event is ChatMessagesMessage =>
    event.type === 'chat-messages' && event.chatId === chatId);
}

function summariesFor(events: readonly ServerWsMessage[], chatId: string): ChatTranscriptAdvancedMessage[] {
  return events.filter((event): event is ChatTranscriptAdvancedMessage =>
    event.type === 'chat-transcript-advanced' && event.chatId === chatId);
}

// Applies spans the way the browser cache does: overlap is deduplicated by
// ordinal and a span that skips an ordinal is a gap.
function reconstruct(spans: readonly TranscriptSpan[]): { messages: TranscriptMessage[]; lastOrdinal: number } {
  let messages: TranscriptMessage[] = [];
  let lastOrdinal = 0;
  for (const span of spans) {
    const applied = applyTranscriptAppend(messages, span, lastOrdinal);
    expect(applied.status).toBe('applied');
    messages = applied.messages;
    lastOrdinal = applied.lastOrdinal;
  }
  return { messages, lastOrdinal };
}

async function expectMatchesLedger(
  fixture: IntegrationFixture,
  chatId: string,
  rebuilt: { messages: TranscriptMessage[]; lastOrdinal: number },
): Promise<void> {
  const ledger = await fixture.client.getMessages(chatId);
  expect(rebuilt.lastOrdinal).toBe(ledger.lastOrdinal);
  expect(rebuilt.messages.map((entry) => entry.ordinal)).toEqual(ledger.messages.map((entry) => entry.ordinal));
  expect(new Set(rebuilt.messages.map((entry) => entry.ordinal)).size).toBe(rebuilt.messages.length);
  expect(JSON.parse(JSON.stringify(rebuilt.messages))).toEqual(JSON.parse(JSON.stringify(ledger.messages)));
}

async function startHeldTurn(fixture: IntegrationFixture, chatId: string, content: string) {
  const held = fixture.fakeProviders.openAi.holdNext({ lastUserText: content });
  const accepted = await fixture.client.startDirectChat({
    chatId,
    content,
    projectPath: fixture.dirs.project,
    agent: fixture.directAgents.openAi,
  });
  await held.received;
  return { held, turnId: accepted.turnId! };
}

async function runTurn(fixture: IntegrationFixture, chatId: string, content: string): Promise<void> {
  const held = fixture.fakeProviders.openAi.holdNext({ lastUserText: content });
  const cursor = fixture.client.markEvents();
  const accepted = await fixture.client.runDirectChat({ chatId, content, agent: fixture.directAgents.openAi });
  await held.received;
  held.releaseEcho();
  await fixture.client.waitForTurnTerminal(chatId, accepted.turnId, { afterIndex: cursor });
}

async function settle(...clients: GarconTestClient[]): Promise<void> {
  for (const client of clients) await client.ping();
}

describe('chat transcript interest delivery', () => {
  test('sends bodies only to displaying sockets and summaries to the rest, ahead of lifecycle events', async () => {
    await withIntegrationFixture('transcript-interest-delivery', async (fixture) => {
      const chatId = fixture.newChatId();
      const displaying = await fixture.connectObserver('displaying');
      const background = await fixture.connectObserver('background');
      await displaying.watchTranscripts(chatId);
      const displayingCursor = displaying.markEvents();
      const backgroundCursor = background.markEvents();

      const content = `interest-delivery ${'deterministic synthetic padding '.repeat(2_000)}`.trimEnd();
      const { held, turnId } = await startHeldTurn(fixture, chatId, content);
      held.releaseEcho();
      await Promise.all([
        displaying.waitForTurnTerminal(chatId, turnId, { afterIndex: displayingCursor }),
        background.waitForTurnTerminal(chatId, turnId, { afterIndex: backgroundCursor }),
      ]);
      await settle(displaying, background);

      const shown = displaying.eventsSince(displayingCursor);
      const hidden = background.eventsSince(backgroundCursor);
      expect(summariesFor(shown, chatId)).toEqual([]);
      expect(bodiesFor(hidden, chatId)).toEqual([]);
      const bodies = bodiesFor(shown, chatId);
      const summaries = summariesFor(hidden, chatId);
      expect(summaries.map(({ firstOrdinal, lastOrdinal, transcriptViewId }) =>
        ({ firstOrdinal, lastOrdinal, transcriptViewId })))
        .toEqual(bodies.map(({ firstOrdinal, lastOrdinal, transcriptViewId }) =>
          ({ firstOrdinal, lastOrdinal, transcriptViewId })));
      expect(summaries.map((summary) => summary.activity)).toEqual(bodies.map((body) =>
        summarizeTranscriptActivity(body.messages.map((entry) => entry.message))));
      expect(summaries.some((summary) => summary.activity.preview?.content.startsWith('echo:interest-delivery')))
        .toBe(true);
      const bodyBytes = bodies.reduce((total, body) => total + Buffer.byteLength(JSON.stringify(body)), 0);
      const summaryBytes = summaries.reduce((total, summary) => total + Buffer.byteLength(JSON.stringify(summary)), 0);
      expect(summaryBytes).toBeLessThan(bodyBytes / 10);
      console.info('Transcript delivery decoded bytes', JSON.stringify({ bodyBytes, summaryBytes }));
      expect(background.rawEvents().some((raw) => JSON.stringify(raw).includes('echo:interest-delivery')
        && (raw as { type?: string }).type !== 'chat-transcript-advanced'
        && (raw as { type?: string }).type !== 'chat-list-refresh-requested'
        && (raw as { type?: string }).type !== 'chat-title-updated')).toBe(false);
      await expectMatchesLedger(fixture, chatId, reconstruct(bodies));

      for (const [events, transcriptType] of [
        [shown, 'chat-messages'],
        [hidden, 'chat-transcript-advanced'],
      ] as const) {
        const types = events.filter((event) => 'chatId' in event && event.chatId === chatId)
          .map((event) => event.type);
        const terminal = types.indexOf('agent-run-finished');
        expect(terminal).toBeGreaterThan(-1);
        expect(types.lastIndexOf(transcriptType)).toBeLessThan(terminal);
        expect(types.lastIndexOf(transcriptType)).toBeLessThan(types.lastIndexOf('chat-processing-updated'));
      }
    });
  }, TEST_TIMEOUT_MS);

  test('catches up a chat shown and hidden mid-turn with no gap or duplicate', async () => {
    await withIntegrationFixture('transcript-interest-mid-turn', async (fixture) => {
      const chatId = fixture.newChatId();
      const tab = await fixture.connectObserver('tab');
      const cursor = tab.markEvents();

      const first = await startHeldTurn(fixture, chatId, 'mid-turn-first');
      await fixture.client.waitForCommittedUserInput(chatId, 'mid-turn-first');
      await settle(tab);
      expect(bodiesFor(tab.eventsSince(cursor), chatId)).toEqual([]);
      const hiddenStart = summariesFor(tab.eventsSince(cursor), chatId);
      expect(hiddenStart.length).toBeGreaterThan(0);

      // Declares before reading the catch-up, as the browser does, so rows
      // committed in between arrive as bodies and are deduplicated by ordinal.
      const watchCursor = tab.markEvents();
      await tab.watchTranscripts(chatId);
      const view = (await fixture.client.getMessages(chatId)).transcriptViewId;
      const caughtUp = await tab.subscribe(chatId, view, 0);
      expect(caughtUp.firstOrdinal).toBe(1);
      expect(caughtUp.throughOrdinal).toBeGreaterThanOrEqual(hiddenStart.at(-1)!.lastOrdinal);
      const shownCursor = tab.markEvents();
      first.held.releaseEcho();
      await tab.waitForTurnTerminal(chatId, first.turnId, { afterIndex: shownCursor });
      await settle(tab);
      expect(bodiesFor(tab.eventsSince(shownCursor), chatId).length).toBeGreaterThan(0);
      expect(summariesFor(tab.eventsSince(shownCursor), chatId)).toEqual([]);
      await expectMatchesLedger(
        fixture,
        chatId,
        reconstruct([caughtUp, ...bodiesFor(tab.eventsSince(watchCursor), chatId)]),
      );

      const secondHeld = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'mid-turn-second' });
      const secondCursor = tab.markEvents();
      const second = await fixture.client.runDirectChat({
        chatId, content: 'mid-turn-second', agent: fixture.directAgents.openAi,
      });
      await secondHeld.received;
      await tab.waitForCommittedUserInput(chatId, 'mid-turn-second', { afterIndex: secondCursor });
      await tab.setTranscriptInterest([]);
      const hiddenCursor = tab.markEvents();
      secondHeld.releaseEcho();
      await tab.waitForTurnTerminal(chatId, second.turnId, { afterIndex: hiddenCursor });
      await settle(tab);
      expect(bodiesFor(tab.eventsSince(hiddenCursor), chatId)).toEqual([]);
      const missed = summariesFor(tab.eventsSince(hiddenCursor), chatId);
      expect(missed.length).toBeGreaterThan(0);

      const shownSpans = [caughtUp, ...bodiesFor(tab.eventsSince(watchCursor), chatId)];
      const beforeHide = reconstruct(shownSpans);
      expect(missed[0]!.firstOrdinal).toBe(beforeHide.lastOrdinal + 1);
      await tab.watchTranscripts(chatId);
      const replay = await tab.subscribe(chatId, view, beforeHide.lastOrdinal);
      expect(replay.firstOrdinal).toBe(beforeHide.lastOrdinal + 1);
      expect(replay.lastOrdinal).toBe(missed.at(-1)!.lastOrdinal);
      await expectMatchesLedger(fixture, chatId, reconstruct([...shownSpans, replay]));
    });
  }, TEST_TIMEOUT_MS);

  test('delivers bodies for every chat shown in split panels', async () => {
    await withIntegrationFixture('transcript-interest-split-panels', async (fixture) => {
      const left = fixture.newChatId();
      const right = fixture.newChatId();
      const hidden = fixture.newChatId();
      const split = await fixture.connectObserver('split');
      await split.watchTranscripts(left, right);
      const cursor = split.markEvents();

      for (const [chatId, content] of [[left, 'split-left'], [right, 'split-right'], [hidden, 'split-hidden']]) {
        const { held, turnId } = await startHeldTurn(fixture, chatId!, content!);
        const turnCursor = fixture.client.markEvents();
        held.releaseEcho();
        await fixture.client.waitForTurnTerminal(chatId!, turnId, { afterIndex: turnCursor });
      }
      await settle(split);

      const events = split.eventsSince(cursor);
      for (const chatId of [left, right]) {
        expect(summariesFor(events, chatId)).toEqual([]);
        await expectMatchesLedger(fixture, chatId, reconstruct(bodiesFor(events, chatId)));
      }
      expect(bodiesFor(events, hidden)).toEqual([]);
      expect(summariesFor(events, hidden).length).toBeGreaterThan(0);
    });
  }, TEST_TIMEOUT_MS);

  test('drops interest with its socket and restores it with replay after reconnect', async () => {
    await withIntegrationFixture('transcript-interest-reconnect', async (fixture) => {
      const chatId = fixture.newChatId();
      const tab = await fixture.connectObserver('tab');
      await tab.watchTranscripts(chatId);
      const firstCursor = tab.markEvents();
      const { held, turnId } = await startHeldTurn(fixture, chatId, 'reconnect-first');
      held.releaseEcho();
      await tab.waitForTurnTerminal(chatId, turnId, { afterIndex: firstCursor });
      await settle(tab);
      const firstBodies = bodiesFor(tab.eventsSince(firstCursor), chatId);
      const before = reconstruct(firstBodies);
      const view = (await fixture.client.getMessages(chatId)).transcriptViewId;

      await tab.disconnect();
      await runTurn(fixture, chatId, 'reconnect-while-away');
      await tab.setTranscriptInterest([]);
      await tab.reconnect();
      const freshCursor = tab.markEvents();
      await runTurn(fixture, chatId, 'reconnect-undeclared');
      await settle(tab);
      expect(bodiesFor(tab.eventsSince(freshCursor), chatId)).toEqual([]);
      expect(summariesFor(tab.eventsSince(freshCursor), chatId).length).toBeGreaterThan(0);

      await tab.disconnect();
      await tab.setTranscriptInterest([chatId]);
      await tab.reconnect();
      const restoredCursor = tab.markEvents();
      const replay = await tab.subscribe(chatId, view, before.lastOrdinal);
      await runTurn(fixture, chatId, 'reconnect-restored');
      await settle(tab);
      const restored = tab.eventsSince(restoredCursor);
      expect(summariesFor(restored, chatId)).toEqual([]);
      expect(replay.firstOrdinal).toBe(before.lastOrdinal + 1);
      await expectMatchesLedger(fixture, chatId, reconstruct([
        ...firstBodies,
        replay,
        ...bodiesFor(restored, chatId),
      ]));
    });
  }, TEST_TIMEOUT_MS);
});
