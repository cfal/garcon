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
  const cases = [
    {
      name: 'matches an identity-carrying echo independent of content',
      records: [record('request-1')],
      messages: [message({ content: 'provider-normalized', metadata: { clientRequestId: 'request-1' } })],
      expected: ['request-1'],
      identityless: [],
    },
    {
      name: 'matches a nearby identityless echo',
      records: [record('request-1')],
      messages: [message()],
      expected: ['request-1'],
      identityless: ['request-1'],
    },
    {
      name: 'conserves duplicated identityless content by occurrence',
      records: [record('request-1'), record('request-2')],
      messages: [message(), message()],
      expected: ['request-1', 'request-2'],
      identityless: ['request-1', 'request-2'],
    },
    {
      name: 'matches image-bearing echoes by content digest and metadata',
      records: [record('request-image', {
        images: [{ name: 'capture.png', mimeType: 'image/png', data: 'data:image/png;base64,YQ==' }],
      })],
      messages: [message({
        images: [{ name: 'capture.png', mimeType: 'image/png', data: 'data:image/png;base64,YQ==' }],
      })],
      expected: ['request-image'],
      identityless: ['request-image'],
    },
    {
      name: 'rejects an identityless echo outside the time window',
      records: [record('request-1')],
      messages: [message({ timestamp: '2026-06-01T00:05:00.001Z' })],
      expected: [],
      identityless: [],
    },
    {
      name: 'rejects a conflicting turn identity',
      records: [record('request-1', { turnId: 'turn-1' })],
      messages: [message({ metadata: { turnId: 'turn-2' } })],
      expected: [],
      identityless: [],
    },
  ];

  for (const fixture of cases) {
    it(fixture.name, () => {
      const result = matchingRequestIds(fixture.records, fixture.messages, new Map());
      expect([...result.requestIds]).toEqual(fixture.expected);
      expect([...result.identitylessRequestIds]).toEqual(fixture.identityless);
    });
  }

  it('does not claim identityless evidence twice across batches', () => {
    const records = [record('request-1')];
    const messages = [message()];
    const first = matchingRequestIds(records, messages, new Map());
    const second = matchingRequestIds(
      [record('request-2')],
      messages,
      first.identitylessEvidence,
    );

    expect([...first.requestIds]).toEqual(['request-1']);
    expect([...second.requestIds]).toEqual([]);
  });

  it('can restrict settlement to explicit request identities', () => {
    const result = matchingRequestIds(
      [record('explicit'), record('identityless')],
      [
        message({ metadata: { clientRequestId: 'explicit' } }),
        message(),
      ],
      new Map(),
      false,
    );

    expect([...result.requestIds]).toEqual(['explicit']);
    expect([...result.identitylessRequestIds]).toEqual([]);
  });
});
