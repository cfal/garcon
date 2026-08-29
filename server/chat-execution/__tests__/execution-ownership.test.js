import { describe, expect, it } from 'bun:test';
import { ExecutionOwnership } from '../execution-ownership.ts';
import { QueueExecutionAttempt } from '../execution-attempt.ts';

const CHAT_ID = 'chat-1';

// The coordinator screens direct-turn callers on the wider `hasOwner || isChatRunning`, so these
// refusals are unreachable through it today. They exist so the class keeps its own exclusivity
// invariant if a future caller reaches it directly.
describe('ExecutionOwnership direct-turn exclusivity', () => {
  it('refuses a second direct turn while one is reserved', () => {
    const ownership = new ExecutionOwnership();
    ownership.reserveDirect(CHAT_ID, { turnId: 'turn-1' });

    expect(() => ownership.reserveDirect(CHAT_ID, { turnId: 'turn-2' })).toThrow(
      'Cannot reserve a direct turn while another operation owns execution',
    );
  });

  it('refuses a direct turn while a previous turn is still settling', () => {
    const ownership = new ExecutionOwnership();
    const reservation = ownership.reserveDirect(CHAT_ID, { turnId: 'turn-1' });
    // Releasing the reservation leaves the attempt installed: the settlement window.
    ownership.releaseDirect(reservation);

    expect(() => ownership.reserveDirect(CHAT_ID, { turnId: 'turn-2' })).toThrow(
      'Cannot reserve a direct turn while another operation owns execution',
    );
  });

  it('refuses a direct turn while a drain or transcript snapshot owns the chat', () => {
    const draining = new ExecutionOwnership();
    draining.beginDrain(CHAT_ID);
    expect(() => draining.reserveDirect(CHAT_ID, { turnId: 'turn-1' })).toThrow(
      'Cannot reserve a direct turn while another operation owns execution',
    );

    const snapshotting = new ExecutionOwnership();
    snapshotting.reserveTranscriptSnapshot(CHAT_ID);
    expect(() => snapshotting.reserveDirect(CHAT_ID, { turnId: 'turn-1' })).toThrow(
      'Cannot reserve a direct turn while another operation owns execution',
    );
  });

  it('reserves again once the settling attempt is removed', () => {
    const ownership = new ExecutionOwnership();
    const reservation = ownership.reserveDirect(CHAT_ID, { turnId: 'turn-1' });
    const attempt = ownership.attempt(CHAT_ID);
    ownership.releaseDirect(reservation);
    expect(ownership.removeAttempt(CHAT_ID, attempt)).toBe(true);

    expect(() => ownership.reserveDirect(CHAT_ID, { turnId: 'turn-2' })).not.toThrow();
  });

  it('refuses a transcript snapshot while a turn is still settling', () => {
    const ownership = new ExecutionOwnership();
    ownership.installAttempt(CHAT_ID, new QueueExecutionAttempt({ turnId: 'turn-1' }, 'entry-1'));

    expect(() => ownership.reserveTranscriptSnapshot(CHAT_ID)).toThrow(
      'Another chat operation already owns execution',
    );
  });
});

describe('ExecutionOwnership owner-change watches', () => {
  it('keeps cancelled watches pending and resolves active watches', async () => {
    const ownership = new ExecutionOwnership();
    const cancelled = ownership.watchOwnerChange(CHAT_ID);
    let cancelledResolved = false;
    void cancelled.promise.then(() => { cancelledResolved = true; });

    cancelled.cancel();
    ownership.notifyOwnersChanged(CHAT_ID);
    await Promise.resolve();
    expect(cancelledResolved).toBe(false);

    const active = ownership.watchOwnerChange(CHAT_ID);
    let activeResolved = false;
    void active.promise.then(() => { activeResolved = true; });
    ownership.notifyOwnersChanged('other-chat');
    await Promise.resolve();
    expect(activeResolved).toBe(false);

    ownership.notifyOwnersChanged(CHAT_ID);
    await active.promise;
    expect(activeResolved).toBe(true);
  });

  it('resolves a watch-only chat when shutdown begins', async () => {
    const ownership = new ExecutionOwnership();
    const watch = ownership.watchOwnerChange(CHAT_ID);

    ownership.beginShutdown(new Error('shutdown'));

    await watch.promise;
  });
});
