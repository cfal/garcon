import { describe, expect, it } from 'bun:test';
import { UserMessage } from '../../../common/chat-types.ts';
import { matchingRequestIds } from '../pending-input-matching.ts';

const BASE_TIME = '2026-06-01T00:00:00.000Z';

function record(clientRequestId, overrides = {}) {
  return {
    chatId: 'chat-1',
    clientRequestId,
    content: 'hello',
    createdAt: BASE_TIME,
    deliveryStatus: 'accepted',
    ...overrides,
  };
}

function message(overrides = {}) {
  return new UserMessage(
    overrides.timestamp ?? '2026-06-01T00:00:00.100Z',
    overrides.content ?? 'hello',
    overrides.images,
    overrides.metadata,
  );
}

describe('matchingRequestIds', () => {
  it('matches an exact client request identity independent of content', () => {
    const matches = matchingRequestIds(
      [record('request-1')],
      [message({ content: 'provider-normalized', metadata: { clientRequestId: 'request-1' } })],
    );

    expect([...matches]).toEqual(['request-1']);
  });

  it('matches the exact forwarded provider request identity', () => {
    const matches = matchingRequestIds(
      [record('request-1', { clientMessageId: 'message-1' })],
      [message({
        content: 'provider-normalized',
        metadata: { upstreamRequestId: 'message-1' },
      })],
    );

    expect([...matches]).toEqual(['request-1']);
  });

  it('does not equate identical content without a shared identity', () => {
    const matches = matchingRequestIds(
      [record('request-1')],
      [message()],
    );

    expect([...matches]).toEqual([]);
  });

  it('does not content-match a conflicting forwarded identity', () => {
    const matches = matchingRequestIds(
      [record('request-1', { clientMessageId: 'message-1' })],
      [message({ metadata: { upstreamRequestId: 'message-2' } })],
    );

    expect([...matches]).toEqual([]);
  });

  it('reconciles repeated prompts only by their forwarded identities', () => {
    const matches = matchingRequestIds(
      [
        record('request-1', { clientMessageId: 'message-1' }),
        record('request-2', { clientMessageId: 'message-2' }),
      ],
      [
        message({ metadata: { upstreamRequestId: 'message-2' } }),
        message({ metadata: { upstreamRequestId: 'message-1' } }),
      ],
    );

    expect([...matches]).toEqual(['request-1', 'request-2']);
  });

  it('allows one provider row to settle only one pending request', () => {
    const matches = matchingRequestIds(
      [
        record('request-1'),
        record('request-2', { clientMessageId: 'message-2' }),
      ],
      [message({
        metadata: {
          clientRequestId: 'request-1',
          upstreamRequestId: 'message-2',
        },
      })],
    );

    expect([...matches]).toEqual(['request-1']);
  });
});
