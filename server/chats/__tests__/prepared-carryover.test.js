import { describe, expect, it } from 'bun:test';
import { PreparedCarryoverStore } from '../prepared-carryover.ts';

const RESULT = { kind: 'compacted', context: { prefix: 'prepared' }, summary: 'summary' };

function prepared(overrides = {}) {
  return {
    chatId: 'chat-1',
    transcriptViewId: 'view-1',
    targetAgentId: 'claude',
    clientRequestId: 'request-1',
    result: RESULT,
    ...overrides,
  };
}

function take(store, overrides = {}) {
  return store.take({
    chatId: 'chat-1',
    transcriptViewId: 'view-1',
    targetAgentId: 'claude',
    clientRequestId: 'request-1',
    ...overrides,
  });
}

describe('PreparedCarryoverStore', () => {
  it('consumes a matching result once', () => {
    const store = new PreparedCarryoverStore();
    store.deposit(prepared());

    expect(take(store)).toBe(RESULT);
    expect(take(store)).toBeNull();
  });

  it.each([
    ['view', { transcriptViewId: 'view-2' }],
    ['agent', { targetAgentId: 'codex' }],
    ['request', { clientRequestId: 'request-2' }],
    ['missing request', { clientRequestId: null }],
  ])('discards a result after a mismatched %s fence', (_label, mismatch) => {
    const store = new PreparedCarryoverStore();
    store.deposit(prepared());

    expect(take(store, mismatch)).toBeNull();
    expect(take(store)).toBeNull();
  });

  it('replaces an older result and discards idempotently', () => {
    const store = new PreparedCarryoverStore();
    const replacement = { kind: 'complete', context: { prefix: 'replacement' } };
    store.deposit(prepared());
    store.deposit(prepared({ result: replacement }));

    expect(take(store)).toBe(replacement);
    store.discard('chat-1');
    store.discard('chat-1');
    expect(take(store)).toBeNull();
  });
});
