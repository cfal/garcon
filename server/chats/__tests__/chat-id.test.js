import { describe, expect, it } from 'bun:test';

import {
  chatIdCreatedAt,
  chatIdFromEpochMicroseconds,
  chatIdFromTimestamp,
  legacyChatIdToCanonical,
  parseChatId,
} from '../../../common/chat-id.ts';
import { ChatIdAllocator } from '../chat-id-allocator.ts';

describe('chat ID contract', () => {
  it('parses the canonical safe microsecond format', () => {
    const chatId = '1783725900000123';

    expect(parseChatId(chatId)).toBe(chatId);
    expect(Number.isSafeInteger(Number(chatId))).toBe(true);
    expect(chatIdCreatedAt(chatId).toISOString()).toBe(
      new Date(1_783_725_900_000).toISOString(),
    );
  });

  it('formats timestamps and microsecond suffixes', () => {
    expect(chatIdFromTimestamp(1_783_725_900_000, 7)).toBe('1783725900000007');
    expect(chatIdFromEpochMicroseconds(1_783_725_900_000_999n)).toBe(
      '1783725900000999',
    );
  });

  it.each([
    '1783725900000',
    '178372590000007',
    '17837259000000123',
    '178372590000007231252',
    ' 1783725900000123',
    '1783725900000123 ',
    '+178372590000123',
    '178372590000.123',
    '1783725900000e3',
    'abcdefghij123456',
    '9999999999999999',
  ])('rejects invalid ID %s', (chatId) => {
    expect(() => parseChatId(chatId)).toThrow(
      'Chat ID must be a valid 16-digit Unix-microsecond timestamp',
    );
  });

  it('rejects invalid timestamp components', () => {
    expect(() => chatIdFromTimestamp(0, 0)).toThrow();
    expect(() => chatIdFromTimestamp(1_783_725_900_000, -1)).toThrow();
    expect(() => chatIdFromTimestamp(1_783_725_900_000, 1_000)).toThrow();
  });

  it('migrates only common seconds and milliseconds lengths', () => {
    expect(legacyChatIdToCanonical('1772710502')).toBe('1772710502000000');
    expect(legacyChatIdToCanonical('1774634779935')).toBe('1774634779935000');
    expect(legacyChatIdToCanonical('177463477993')).toBeNull();
    expect(legacyChatIdToCanonical('17746347799350')).toBeNull();
    expect(legacyChatIdToCanonical('not-numeric')).toBeNull();
  });
});

describe('ChatIdAllocator', () => {
  it('allocates monotonically within the same millisecond and across clock rollback', () => {
    let now = 1_783_725_900_000;
    const allocator = new ChatIdAllocator({ getChat: () => null }, () => now);

    expect(allocator.allocate()).toBe('1783725900000000');
    expect(allocator.allocate()).toBe('1783725900000001');
    now -= 10;
    expect(allocator.allocate()).toBe('1783725900000002');
  });

  it('skips IDs that already exist in the registry', () => {
    const occupied = new Set(['1783725900000000', '1783725900000001']);
    const allocator = new ChatIdAllocator(
      { getChat: (chatId) => occupied.has(chatId) ? {} : null },
      () => 1_783_725_900_000,
    );

    expect(allocator.allocate()).toBe('1783725900000002');
  });

  it('fails without mutating the registry when allocation is exhausted', () => {
    const getChat = () => ({});
    const allocator = new ChatIdAllocator({ getChat }, () => 1_783_725_900_000);

    expect(() => allocator.allocate()).toThrow('Could not allocate a unique chat ID');
  });
});
