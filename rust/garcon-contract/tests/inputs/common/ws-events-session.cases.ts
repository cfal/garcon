// Session-level calls from web/src/lib/api/__tests__/ws-message-contract.logic.test.ts.
import { expect, test } from 'bun:test';
import {
  ClientRequestErrorMessage,
  ReconnectStateMessage,
  WsFaultMessage,
  WsPongMessage,
  parseServerWsMessage,
} from '../../../../../common/ws-events.ts';

test('parses request errors and faults', () => {
  expect(parseServerWsMessage({
    type: 'client-request-error',
    clientRequestId: 'req-1',
    requestType: 'chat-log',
    code: 'SESSION_NOT_FOUND',
    message: 'Session not found',
    retryable: false,
    chatId: 'chat-1',
  })).toBeInstanceOf(ClientRequestErrorMessage);
  expect(parseServerWsMessage({ type: 'ws-fault', error: 'disconnected' }))
    .toBeInstanceOf(WsFaultMessage);
});

test('strictly parses shared reconnect and pong processing outcomes', () => {
  const serverInstanceId = 'server-instance-test';
  const snapshot = parseServerWsMessage({
    type: 'reconnect-state',
    clientRequestId: 'req-reconnect',
    serverInstanceId,
    processing: {
      outcome: 'snapshot',
      chats: [
        { chatId: 'chat-b', phase: 'stopping' },
        { chatId: ' chat-a ', phase: 'running' },
      ],
    },
    controlResults: [],
  });
  expect(snapshot).toBeInstanceOf(ReconnectStateMessage);
  expect(snapshot).toMatchObject({
    clientRequestId: 'req-reconnect',
    serverInstanceId,
    processing: {
      outcome: 'snapshot',
      chats: [
        { chatId: 'chat-b', phase: 'stopping' },
        { chatId: 'chat-a', phase: 'running' },
      ],
    },
  });

  const pong = parseServerWsMessage({
    type: 'ws-pong',
    clientRequestId: 'req-ping',
    sentAt: 42,
    serverTime: '2026-07-27T00:00:00.000Z',
    processing: {
      outcome: 'snapshot',
      chats: [{ chatId: 'chat-a', phase: 'stopping' }],
    },
    serverInstanceId,
  });
  expect(pong).toBeInstanceOf(WsPongMessage);
  expect(pong).toMatchObject({
    serverInstanceId,
    processing: {
      outcome: 'snapshot',
      chats: [{ chatId: 'chat-a', phase: 'stopping' }],
    },
  });
});

test('constructs reconnect state with mixed control results', () => {
  const serverInstanceId = 'server-a';
  const control = {
    serverInstanceId,
    queue: {
      entries: [], steeringEntryId: null, recentlyDispatched: [], pause: null, reorderRevision: 0,
    },
    version: 1,
    updatedAt: null,
  };
  const results = [
    { chatId: 'chat-1', outcome: 'snapshot', control },
    { chatId: 'chat-2', outcome: 'not-found' },
    { chatId: 'chat-3', outcome: 'unavailable' },
  ] as const;
  const message = new ReconnectStateMessage(
    { outcome: 'unavailable' },
    [...results],
    serverInstanceId,
  );
  expect(message.controlResults).toEqual(results);
});
