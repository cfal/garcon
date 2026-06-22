import { describe, expect, it } from 'bun:test';
import { InMemoryLastSelectedChatState } from '../last-selected-chat-state.ts';

describe('InMemoryLastSelectedChatState', () => {
  it('stores normalized chat ids and clears on null', () => {
    const state = new InMemoryLastSelectedChatState();

    expect(state.getLastSelectedChatId()).toBeNull();
    state.setLastSelectedChatId(' chat-1 ');
    expect(state.getLastSelectedChatId()).toBe('chat-1');

    state.setLastSelectedChatId(null);
    expect(state.getLastSelectedChatId()).toBeNull();
  });

  it('only clears matching chat ids', () => {
    const state = new InMemoryLastSelectedChatState();
    state.setLastSelectedChatId('chat-1');

    state.clearIf('chat-2');
    expect(state.getLastSelectedChatId()).toBe('chat-1');

    state.clearIf('chat-1');
    expect(state.getLastSelectedChatId()).toBeNull();
  });
});
