import { expect, test } from 'bun:test';
import { TranscriptNoticeMessage } from '../../../common/chat-types.js';
import type { AgentChildOutcomeNoticeDetail } from '../../../common/garcon-agent-result.js';
import { garconCommandResultContent } from '../../../common/garcon-command-results.js';
import { ChatMessagesMessage, type ServerWsMessage } from '../../../common/ws-events.js';
import { waitForChildReply } from '../../support/child-outcome.js';
import type { HeldResponsesRequest, RecordedResponsesRequest } from '../../support/fake-openai-responses-server.js';
import type { GarconTestClient } from '../../support/garcon-client.js';

const PARENT = '1000000000000001';
const CHILD = '1000000000000002';
const VIEW = '00000000-0000-4000-8000-000000000001';

function outcomeEvent(detail: AgentChildOutcomeNoticeDetail, chatId = PARENT): ChatMessagesMessage {
  return new ChatMessagesMessage(chatId, VIEW, [{
    ordinal: 1,
    message: new TranscriptNoticeMessage('2026-01-01T00:00:00.000Z', 'Synthetic child outcome.', detail),
  }], 1, 1, []);
}

function fixture(detail: AgentChildOutcomeNoticeDetail) {
  const lifecycle = Promise.withResolvers<ChatMessagesMessage>();
  const target = { chatId: PARENT, type: detail.type, ref: detail.ref, status: detail.status, afterIndex: 7 };
  let deliveryTimerStarts = 0;
  const client = {
    async waitForEvent<T extends ServerWsMessage>(
      predicate: (message: ServerWsMessage) => message is T,
      _description: string,
      options: { afterIndex?: number; timeoutMs?: number } = {},
    ): Promise<T> {
      expect(options).toEqual({ afterIndex: 7, timeoutMs: 60_000 });
      expect(predicate(outcomeEvent(detail, CHILD))).toBe(false);
      expect(predicate(outcomeEvent({ ...detail, ref: 'unrelated' }))).toBe(false);
      expect(predicate(outcomeEvent(detail.type === 'agent-start-outcome'
        ? { ...detail, type: 'agent-resume-outcome' }
        : { ...detail, type: 'agent-start-outcome' }))).toBe(false);
      expect(predicate(outcomeEvent({ ...detail, status: 'accepted', chatId: CHILD }))).toBe(detail.status === 'accepted');
      const event = await lifecycle.promise;
      if (!predicate(event)) throw new Error('Unexpected synthetic lifecycle event');
      return event;
    },
  } satisfies Pick<GarconTestClient, 'waitForEvent'>;
  const held = {
    get received() {
      deliveryTimerStarts += 1;
      const request: RecordedResponsesRequest = {
        id: 1, responseId: 'resp_synthetic', rawBody: {},
        body: { model: 'synthetic', input: [{ role: 'user', content: 'Synthetic result.' }], stream: true, store: false },
        lastUserText: garconCommandResultContent(detail), receivedAt: 0, abortedAt: null,
      };
      return Promise.resolve(request);
    },
  } satisfies Pick<HeldResponsesRequest, 'received'>;
  return { client, held, target, lifecycle, deliveryTimerStarts: () => deliveryTimerStarts };
}

for (const type of ['agent-start-outcome', 'agent-resume-outcome'] as const) {
  for (const status of ['accepted', 'completed'] as const) {
    test(`${type} ${status} starts the parent delivery deadline only after child lifecycle settles`, async () => {
      const detail: AgentChildOutcomeNoticeDetail = {
        type, ref: 'synthetic-ref', async: false, requestViewId: VIEW, requestOrdinal: 1,
        ...(status === 'accepted' ? { status, chatId: CHILD }
          : { status, chatId: CHILD, output: { availability: 'available', completeness: 'complete', text: 'Synthetic final.' } }),
      };
      const f = fixture(detail);
      const reply = waitForChildReply(f.client, f.held, f.target);
      void reply.catch(() => undefined);
      try {
        expect(f.deliveryTimerStarts()).toBe(0);
        f.lifecycle.resolve(outcomeEvent(detail));
        await expect(reply).resolves.toEqual(detail);
        expect(f.deliveryTimerStarts()).toBe(1);
      } finally {
        f.lifecycle.resolve(outcomeEvent(detail));
        await reply.catch(() => undefined);
      }
    });
  }
}

test('child lifecycle failure never starts a parent delivery deadline', async () => {
  const detail: AgentChildOutcomeNoticeDetail = {
    type: 'agent-start-outcome', ref: 'synthetic-ref', async: false,
    requestViewId: VIEW, requestOrdinal: 1, status: 'accepted', chatId: CHILD,
  };
  const f = fixture(detail);
  const reply = waitForChildReply(f.client, f.held, f.target);
  const failure = new Error('Synthetic readiness deadline expired');
  f.lifecycle.reject(failure);
  await expect(reply).rejects.toBe(failure);
  expect(f.deliveryTimerStarts()).toBe(0);
});

test('parent delivery must equal the exact recorded child outcome', async () => {
  const detail: AgentChildOutcomeNoticeDetail = {
    type: 'agent-start-outcome', ref: 'synthetic-ref', async: false,
    requestViewId: VIEW, requestOrdinal: 1, status: 'accepted', chatId: CHILD,
  };
  const f = fixture(detail);
  const wrongReply = {
    get received() {
      return f.held.received.then((request) => ({
        ...request, lastUserText: garconCommandResultContent({ ...detail, ref: 'another-request' }),
      }));
    },
  } satisfies Pick<HeldResponsesRequest, 'received'>;
  const reply = waitForChildReply(f.client, wrongReply, f.target);
  f.lifecycle.resolve(outcomeEvent(detail));
  await expect(reply).rejects.toThrow();
});
