import { expect, mock, test } from 'bun:test';
import { AssistantMessage } from '../../../common/chat-types.js';
import { ChatTranscriptHeadUpdatedMessage, emptyResponseClassOrdinals } from '../../../common/transcript-display-events.js';
import { AgentRunFinishedMessage, ChatProcessingUpdatedMessage } from '../../../common/ws-events.js';
import type { PrimaryWsServerMessage } from '../../../common/ws-protocol.js';
import type { GarconTestClient } from '../../support/garcon-client.js';
import { LIVE_TURN_TIMEOUT_MS, waitForVisibleResponse } from '../../support/live-agent.js';
import { rejectionOf } from '../../support/promise-assertions.js';

const terminal = new AgentRunFinishedMessage('chat', 0, 'source-turn');
const running = new ChatProcessingUpdatedMessage('chat', 'running');
const idle = new ChatProcessingUpdatedMessage('chat', null);
const afterIndex = 1;

function responseHead(ordinal: number, view = 'view', chatId = 'chat'): ChatTranscriptHeadUpdatedMessage {
  return new ChatTranscriptHeadUpdatedMessage('server', chatId, view, ordinal, null, null,
    { ...emptyResponseClassOrdinals(), assistant: ordinal }, 0, 0);
}

function fixtureWith(events: readonly PrimaryWsServerMessage[]) {
  const recorded = [responseHead(2), ...events];
  const client = {
    waitForTurnTerminal: mock(async () => terminal),
    getMessages: mock(async () => ({
      chatId: 'chat', transcriptViewId: 'view', lastOrdinal: 9,
      messages: [2, 4, 8].map(ordinal => ({
        ordinal, message: new AssistantMessage('2026-01-01T00:00:00.000Z', `Synthetic response ${ordinal}`),
      })),
      pageOldestOrdinal: 2, pageNewestOrdinal: 8, nextBeforeOrdinal: null,
      resendCandidates: [], hasMore: false, limit: 100,
    })),
    eventsSince: (index: number) => recorded.slice(index),
    waitForProcessing: mock(async () => idle),
  } satisfies Pick<GarconTestClient, 'waitForTurnTerminal' | 'getMessages' | 'eventsSince' | 'waitForProcessing'>;
  return { client };
}

test('visible response stays with the requested turn after a queued turn finishes', async () => {
  const fixture = fixtureWith([
    running, responseHead(4), idle, terminal,
    running, responseHead(8), idle, new AgentRunFinishedMessage('chat', 0, 'queued-turn'),
  ]);
  await waitForVisibleResponse({ fixture, chatId: 'chat', turnId: 'source-turn', afterIndex });
  expect(fixture.client.waitForProcessing).toHaveBeenCalledWith('chat', false, {
    afterIndex: 3, timeoutMs: LIVE_TURN_TIMEOUT_MS,
  });
});

test('visible response uses the identity returned by an unqualified terminal wait', async () => {
  const fixture = fixtureWith([running, responseHead(4), idle, terminal]);
  await waitForVisibleResponse({ fixture, chatId: 'chat', turnId: undefined, afterIndex });
});

test('visible response selects the head carrying the requested marker', async () => {
  const fixture = fixtureWith([running, responseHead(4), responseHead(8), idle, terminal]);
  await waitForVisibleResponse({ fixture, chatId: 'chat', turnId: 'source-turn', marker: 'response 8', afterIndex });
  expect(fixture.client.waitForProcessing).toHaveBeenCalledWith('chat', false, {
    afterIndex: 4, timeoutMs: LIVE_TURN_TIMEOUT_MS,
  });
});

test.each([
  { name: 'a later turn', events: [running, idle, terminal, running, responseHead(8), idle] },
  { name: 'another view', events: [running, responseHead(8, 'old-view'), idle, terminal] },
  { name: 'another chat', events: [running, responseHead(8, 'view', 'other-chat'), idle, terminal] },
  { name: 'before the event cursor', events: [running, idle, terminal] },
  { name: 'an absent HTTP row', events: [running, responseHead(10), idle, terminal] },
])('visible response rejects evidence from $name', async ({ events }) => {
  const fixture = fixtureWith(events);
  const error = await rejectionOf(waitForVisibleResponse({ fixture, chatId: 'chat', turnId: 'source-turn', afterIndex }));
  expect(error).toBeInstanceOf(Error);
});
