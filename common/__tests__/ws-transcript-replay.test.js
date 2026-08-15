import { describe, expect, it } from 'bun:test';
import { parseServerWsMessage } from '../ws-events.ts';
import { parseClientWsMessage } from '../ws-requests.ts';

const transientFeed = {
  serverInstanceId: 'server-instance-test',
  chatId: 'chat-1',
  transcriptViewId: 'view-1',
  transientRevision: 0,
  rows: [],
};

function replayResponse(overrides = {}) {
  return {
    type: 'chat-subscribed',
    clientRequestId: 'request-1',
    chatId: 'chat-1',
    transcriptViewId: 'view-1',
    messages: [],
    firstOrdinal: 21,
    lastOrdinal: 220,
    nextAfterOrdinal: 220,
    throughOrdinal: 500,
    hasMore: true,
    resendCandidates: [],
    transientFeed,
    ...overrides,
  };
}

describe('bounded transcript replay WebSocket contract', () => {
  it('preserves a continuation watermark on subscribe requests', () => {
    expect(parseClientWsMessage({
      type: 'chat-subscribe',
      clientRequestId: 'request-2',
      chatId: 'chat-1',
      transcriptViewId: 'view-1',
      afterOrdinal: 220,
      throughOrdinal: 500,
    })).toMatchObject({
      afterOrdinal: 220,
      throughOrdinal: 500,
    });
  });

  it('rejects a continuation watermark behind its replay cursor', () => {
    expect(parseClientWsMessage({
      type: 'chat-subscribe',
      clientRequestId: 'request-2',
      chatId: 'chat-1',
      transcriptViewId: 'view-1',
      afterOrdinal: 501,
      throughOrdinal: 500,
    })).toBeNull();
  });

  it('rejects malformed replay cursors instead of restarting from ordinal zero', () => {
    for (const afterOrdinal of [undefined, null, '220', -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(parseClientWsMessage({
        type: 'chat-subscribe',
        clientRequestId: 'request-2',
        chatId: 'chat-1',
        transcriptViewId: 'view-1',
        afterOrdinal,
      })).toBeNull();
    }
  });

  it('rejects malformed continuation watermarks', () => {
    for (const throughOrdinal of [null, '500', -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(parseClientWsMessage({
        type: 'chat-subscribe',
        clientRequestId: 'request-2',
        chatId: 'chat-1',
        transcriptViewId: 'view-1',
        afterOrdinal: 220,
        throughOrdinal,
      })).toBeNull();
    }
  });

  it('preserves the fixed watermark and next cursor on replay responses', () => {
    expect(parseServerWsMessage(replayResponse())).toMatchObject({
      nextAfterOrdinal: 220,
      throughOrdinal: 500,
      hasMore: true,
    });
  });

  it('rejects replay responses without continuation metadata', () => {
    const response = replayResponse();
    delete response.nextAfterOrdinal;
    delete response.throughOrdinal;
    delete response.hasMore;

    expect(parseServerWsMessage(response)).toBeNull();
  });

  it('rejects a replay cursor beyond its fixed watermark', () => {
    expect(parseServerWsMessage(replayResponse({
      nextAfterOrdinal: 501,
      throughOrdinal: 500,
    }))).toBeNull();
  });

  it('rejects replay metadata that does not advance one raw range', () => {
    for (const overrides of [
      { nextAfterOrdinal: 219 },
      { nextAfterOrdinal: 221 },
      { nextAfterOrdinal: 501, throughOrdinal: 500 },
    ]) {
      expect(parseServerWsMessage(replayResponse(overrides))).toBeNull();
    }
  });

  it('requires hasMore to agree with the fixed high-watermark', () => {
    expect(parseServerWsMessage(replayResponse({
      lastOrdinal: 500,
      nextAfterOrdinal: 500,
      throughOrdinal: 500,
      hasMore: true,
    }))).toBeNull();
    expect(parseServerWsMessage(replayResponse({ hasMore: false }))).toBeNull();
    expect(parseServerWsMessage(replayResponse({
      lastOrdinal: 500,
      nextAfterOrdinal: 500,
      throughOrdinal: 500,
      hasMore: false,
    }))).toMatchObject({
      nextAfterOrdinal: 500,
      throughOrdinal: 500,
      hasMore: false,
    });
  });
});
