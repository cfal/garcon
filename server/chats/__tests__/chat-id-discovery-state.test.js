import { describe, expect, it } from 'bun:test';
import { ChatIdDiscoveryState } from '../chat-id-discovery-state.ts';
import { transcriptViewId } from '../../ledger/contracts.ts';

const CHAT_ID = '1787836573296800';
const OTHER_CHAT_ID = '1787836573296801';
const VIEW = transcriptViewId('view-1');
const OTHER_VIEW = transcriptViewId('view-2');

describe('chat ID discovery state', () => {
  it('reserves one disclosure exclusively and completes its exact token', () => {
    const discovery = new ChatIdDiscoveryState(() => true);
    discovery.request(CHAT_ID, VIEW);

    const reserved = discovery.reserve(CHAT_ID, VIEW);
    expect(reserved).not.toBeNull();
    expect(discovery.reserve(CHAT_ID, VIEW)).toBeNull();
    expect(discovery.complete(reserved)).toBe(true);
    expect(discovery.complete(reserved)).toBe(false);
    expect(discovery.reserve(CHAT_ID, VIEW)).toBeNull();
  });

  it('releases a failed reservation for a later dispatch', () => {
    const discovery = new ChatIdDiscoveryState(() => true);
    discovery.request(CHAT_ID, VIEW);
    const first = discovery.reserve(CHAT_ID, VIEW);

    expect(discovery.release(first)).toBe(true);
    const second = discovery.reserve(CHAT_ID, VIEW);
    expect(second).not.toBeNull();
    expect(second.reservationToken).not.toBe(first.reservationToken);
    expect(discovery.complete(second)).toBe(true);
  });

  it('keeps a newer request when an older reservation settles', () => {
    const discovery = new ChatIdDiscoveryState(() => true);
    discovery.request(CHAT_ID, VIEW);
    const stale = discovery.reserve(CHAT_ID, VIEW);
    discovery.request(CHAT_ID, VIEW);

    expect(discovery.complete(stale)).toBe(false);
    expect(discovery.release(stale)).toBe(false);
    expect(discovery.reserve(CHAT_ID, VIEW)).not.toBeNull();
  });

  it('prunes mismatched, disabled, malformed, and explicitly cleared state', () => {
    let enabled = true;
    const invalidChatIds = [];
    const discovery = new ChatIdDiscoveryState(
      () => enabled,
      (error, chatId) => invalidChatIds.push([error, chatId]),
    );
    discovery.request('invalid', VIEW);
    expect(discovery.reserve('invalid', VIEW)).toBeNull();
    expect(invalidChatIds).toHaveLength(1);
    expect(invalidChatIds[0][1]).toBe('invalid');

    discovery.request(CHAT_ID, VIEW);
    expect(discovery.reserve(CHAT_ID, OTHER_VIEW)).toBeNull();
    expect(discovery.reserve(CHAT_ID, VIEW)).not.toBeNull();

    discovery.request(CHAT_ID, VIEW);
    discovery.request(OTHER_CHAT_ID, VIEW);
    discovery.discard(CHAT_ID);
    expect(discovery.reserve(CHAT_ID, VIEW)).toBeNull();
    expect(discovery.reserve(OTHER_CHAT_ID, VIEW)).not.toBeNull();

    discovery.request(CHAT_ID, VIEW);
    discovery.clear();
    expect(discovery.reserve(CHAT_ID, VIEW)).toBeNull();

    discovery.request(CHAT_ID, VIEW);
    enabled = false;
    expect(discovery.reserve(CHAT_ID, VIEW)).toBeNull();
    enabled = true;
    expect(discovery.reserve(CHAT_ID, VIEW)).toBeNull();
  });
});
