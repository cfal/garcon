import { describe, expect, it } from 'bun:test';
import { ExpectedUserAbortTracker } from '../expected-user-aborts.js';

describe('ExpectedUserAbortTracker', () => {
  it('consumes only terminal events for the interrupted turn', () => {
    const tracker = new ExpectedUserAbortTracker();
    tracker.mark('chat-1', { turnId: 'turn-a', clientRequestId: 'req-a' });

    expect(tracker.consume('chat-1', { turnId: 'turn-b', clientRequestId: 'req-b' })).toBe(false);
    expect(tracker.consume('chat-1', { turnId: 'turn-a' })).toBe(true);
  });

  it('suppresses duplicate terminal channels for the same identified turn', () => {
    const tracker = new ExpectedUserAbortTracker();
    tracker.mark('chat-1', { turnId: 'turn-a' });

    expect(tracker.consume('chat-1', { turnId: 'turn-a' })).toBe(true);
    expect(tracker.consume('chat-1', { turnId: 'turn-a' })).toBe(true);
  });

  it('does not let a consumed identityless marker swallow a later failure', () => {
    const tracker = new ExpectedUserAbortTracker();
    tracker.mark('chat-1');

    expect(tracker.consume('chat-1')).toBe(true);
    expect(tracker.consume('chat-1')).toBe(false);
  });

  it('expires old abort expectations', () => {
    let now = 1000;
    const tracker = new ExpectedUserAbortTracker({ ttlMs: 100, now: () => now });
    tracker.mark('chat-1', { turnId: 'turn-a' });
    now = 1101;

    expect(tracker.consume('chat-1', { turnId: 'turn-a' })).toBe(false);
  });

  it('clears abort expectations after a rejected stop', () => {
    const tracker = new ExpectedUserAbortTracker();
    tracker.mark('chat-1', { turnId: 'turn-a' });
    tracker.clear('chat-1');

    expect(tracker.consume('chat-1', { turnId: 'turn-a' })).toBe(false);
  });
});
