import { describe, expect, it } from 'bun:test';
import { ChatIdAllocator } from '../chat-id-allocator.ts';

describe('ChatIdAllocator', () => {
  it('allocates monotonically within the same millisecond and across clock rollback', () => {
    let now = 1_783_725_900_000;
    const allocator = new ChatIdAllocator({ hasChat: () => false }, () => now);

    expect(allocator.allocate()).toBe('1783725900000000');
    expect(allocator.allocate()).toBe('1783725900000001');
    now -= 10;
    expect(allocator.allocate()).toBe('1783725900000002');
  });

  it('skips IDs that already exist in the registry', () => {
    const occupied = new Set(['1783725900000000', '1783725900000001']);
    const allocator = new ChatIdAllocator(
      { hasChat: (chatId) => occupied.has(chatId) },
      () => 1_783_725_900_000,
    );

    expect(allocator.allocate()).toBe('1783725900000002');
  });

  it('fails without mutating the registry when allocation is exhausted', () => {
    const allocator = new ChatIdAllocator({ hasChat: () => true }, () => 1_783_725_900_000);

    expect(() => allocator.allocate()).toThrow('Could not allocate a unique chat ID');
  });
});
