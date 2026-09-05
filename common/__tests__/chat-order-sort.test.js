import { describe, expect, it } from 'bun:test';
import {
  chatActivityTimeMs,
  chatCreationTimeMs,
  compareChatOrderNewestFirst,
  isChatOrderSortKey,
} from '../chat-order-sort.ts';

const chat = (overrides = {}) => ({
  id: '1735689600000000',
  createdAt: null,
  lastActivityAt: null,
  ...overrides,
});

describe('chat order sort', () => {
  it('recognizes supported sort keys', () => {
    expect(isChatOrderSortKey('created')).toBe(true);
    expect(isChatOrderSortKey('activity')).toBe(true);
    expect(isChatOrderSortKey('oldest')).toBe(false);
    expect(isChatOrderSortKey(null)).toBe(false);
  });

  it('prefers valid metadata creation over the id timestamp', () => {
    expect(chatCreationTimeMs(chat({ createdAt: '2024-01-01T00:00:00.000Z' })))
      .toBe(new Date('2024-01-01T00:00:00.000Z').getTime());
  });

  it('falls back from invalid creation metadata to the chat id timestamp', () => {
    expect(chatCreationTimeMs(chat({ createdAt: 'invalid' })))
      .toBe(new Date('2025-01-01T00:00:00.000Z').getTime());
  });

  it('uses the newest valid activity source', () => {
    expect(chatActivityTimeMs(chat({
      createdAt: '2025-01-01T00:00:00.000Z',
      lastActivityAt: '2025-01-03T00:00:00.000Z',
    }))).toBe(new Date('2025-01-03T00:00:00.000Z').getTime());
  });

  it('includes the chat id timestamp when it is newer than metadata', () => {
    expect(chatActivityTimeMs(chat({
      createdAt: '2024-01-01T00:00:00.000Z',
      lastActivityAt: '2024-02-01T00:00:00.000Z',
    }))).toBe(new Date('2025-01-01T00:00:00.000Z').getTime());
  });

  it('does not throw for malformed timestamps and ids', () => {
    expect(chatCreationTimeMs(chat({ id: 'legacy-id', createdAt: 'bad' }))).toBe(0);
    expect(chatActivityTimeMs(chat({
      id: '0000000000000000',
      createdAt: 'bad',
      lastActivityAt: 'also-bad',
    }))).toBe(0);
  });

  it('sorts both keys newest first', () => {
    const input = [
      chat({ id: 'older', createdAt: '2025-01-01T00:00:00.000Z', lastActivityAt: '2025-01-03T00:00:00.000Z' }),
      chat({ id: 'newer', createdAt: '2025-01-02T00:00:00.000Z', lastActivityAt: '2025-01-04T00:00:00.000Z' }),
    ];

    expect([...input].sort(compareChatOrderNewestFirst('created')).map(({ id }) => id))
      .toEqual(['newer', 'older']);
    expect([...input].sort(compareChatOrderNewestFirst('activity')).map(({ id }) => id))
      .toEqual(['newer', 'older']);
  });

  it('keeps equal ranks stable', () => {
    const input = [chat({ id: 'a' }), chat({ id: 'b' }), chat({ id: 'c' })];
    expect([...input].sort(compareChatOrderNewestFirst('created')).map(({ id }) => id))
      .toEqual(['a', 'b', 'c']);
  });
});
