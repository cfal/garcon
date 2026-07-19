import { describe, expect, it } from 'bun:test';

import { UserMessage } from '@garcon/common/chat-types';
import { CursorRequestIdentityStore } from '../cursor-request-identities.js';

describe('CursorRequestIdentityStore', () => {
  it('annotates loaded Cursor user messages with the matching client request identity', () => {
    const store = new CursorRequestIdentityStore();
    store.rememberTurn({
      chatId: 'chat-1',
      agentSessionId: 'cursor-session-1',
      clientRequestId: 'req-1',
      turnId: 'turn-1',
    });
    store.markUpstreamRequestId({
      chatId: 'chat-1',
      agentSessionId: 'cursor-session-1',
      clientRequestId: 'req-1',
      turnId: 'turn-1',
      upstreamRequestId: 'cursor-req-1',
    });

    const messages = store.applyToMessages([
      new UserMessage('2026-05-22T00:00:00.000Z', 'hi', undefined, {
        upstreamRequestId: 'cursor-req-1',
      }),
    ], {
      chatId: 'chat-1',
      agentSessionId: 'cursor-session-1',
    });

    expect(messages[0].metadata).toEqual({
      upstreamRequestId: 'cursor-req-1',
      clientRequestId: 'req-1',
      turnId: 'turn-1',
    });
  });

  it('does not annotate a different Cursor request id', () => {
    const store = new CursorRequestIdentityStore();
    store.markUpstreamRequestId({
      chatId: 'chat-1',
      agentSessionId: 'cursor-session-1',
      clientRequestId: 'req-1',
      upstreamRequestId: 'cursor-req-1',
    });

    const messages = store.applyToMessages([
      new UserMessage('2026-05-22T00:00:00.000Z', 'hi', undefined, {
        upstreamRequestId: 'cursor-req-2',
      }),
    ], {
      chatId: 'chat-1',
      agentSessionId: 'cursor-session-1',
    });

    expect(messages[0].metadata).toEqual({
      upstreamRequestId: 'cursor-req-2',
    });
  });

  it('annotates the latest anonymous loaded user after Cursor emits the live user echo', () => {
    const store = new CursorRequestIdentityStore();
    store.rememberTurn({
      chatId: 'chat-1',
      agentSessionId: 'cursor-session-1',
      clientRequestId: 'req-1',
      turnId: 'turn-1',
    });
    store.markUserEcho({
      chatId: 'chat-1',
      agentSessionId: 'cursor-session-1',
      clientRequestId: 'req-1',
      turnId: 'turn-1',
    });

    const messages = store.applyToMessages([
      new UserMessage('2026-05-22T00:00:00.000Z', 'earlier', undefined, {
        upstreamRequestId: 'cursor-req-0',
      }),
      new UserMessage('2026-05-22T00:00:01.000Z', 'current'),
    ], {
      chatId: 'chat-1',
      agentSessionId: 'cursor-session-1',
    });

    expect(messages[0].metadata).toEqual({ upstreamRequestId: 'cursor-req-0' });
    expect(messages[1].metadata).toEqual({
      clientRequestId: 'req-1',
      turnId: 'turn-1',
    });
  });
});
