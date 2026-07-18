import { describe, expect, it } from 'bun:test';
import { ExpectedUserAbortTracker } from '../expected-user-aborts.js';

describe('ExpectedUserAbortTracker', () => {
  it('consumes only terminal events for the interrupted turn', () => {
    const tracker = new ExpectedUserAbortTracker();
    tracker.mark('chat-1', { turnId: 'turn-a', clientRequestId: 'req-a' });

    expect(tracker.consume('chat-1', { turnId: 'turn-b', clientRequestId: 'req-b' })).toBe(false);
    expect(tracker.consume('chat-1', { turnId: 'turn-a' })).toBe('first');
  });

  it('suppresses duplicate terminal channels for the same identified turn', () => {
    const tracker = new ExpectedUserAbortTracker();
    tracker.mark('chat-1', { turnId: 'turn-a' });

    expect(tracker.consume('chat-1', { turnId: 'turn-a' })).toBe('first');
    expect(tracker.consume('chat-1', { turnId: 'turn-a' })).toBe('duplicate');
  });

  it('does not let a consumed identityless marker swallow a later failure', () => {
    const tracker = new ExpectedUserAbortTracker();
    tracker.mark('chat-1');

    expect(tracker.consume('chat-1')).toBe('first');
    expect(tracker.consume('chat-1')).toBe(false);
  });

  it('does not assign an identified terminal to an identityless stop', () => {
    const tracker = new ExpectedUserAbortTracker();
    tracker.mark('chat-1', {}, 'stop-a');

    expect(tracker.consume('chat-1', { turnId: 'turn-a' })).toBe(false);
  });

  it('retires duplicate identityless stops only on an identityless terminal', () => {
    const tracker = new ExpectedUserAbortTracker();
    tracker.mark('chat-1', {}, 'stop-a');
    tracker.mark('chat-1', {}, 'stop-b');

    expect(tracker.consume('chat-1')).toBe('first');
    expect(tracker.consume('chat-1')).toBe(false);
  });

  it('retains independent expectations for overlapping stopped turns', () => {
    const tracker = new ExpectedUserAbortTracker();
    tracker.mark('chat-1', { turnId: 'turn-a' }, 'stop-a');
    tracker.mark('chat-1', { turnId: 'turn-b' }, 'stop-b');

    expect(tracker.consume('chat-1', { turnId: 'turn-a' })).toBe('first');
    expect(tracker.consume('chat-1', { turnId: 'turn-b' })).toBe('first');
  });

  it('retains identified abort expectations until their terminal arrives', () => {
    let now = 1000;
    const tracker = new ExpectedUserAbortTracker({ ttlMs: 100, now: () => now });
    tracker.mark('chat-1', { turnId: 'turn-a' });
    now = 1101;

    expect(tracker.consume('chat-1', { turnId: 'turn-a' })).toBe('first');
  });

  it('expires old identityless abort expectations', () => {
    let now = 1000;
    const tracker = new ExpectedUserAbortTracker({ ttlMs: 100, now: () => now });
    tracker.mark('chat-1');
    now = 1101;

    expect(tracker.consume('chat-1')).toBe(false);
  });

  it('clears abort expectations after a rejected stop', () => {
    const tracker = new ExpectedUserAbortTracker();
    tracker.mark('chat-1', { turnId: 'turn-a' });
    tracker.clear('chat-1');

    expect(tracker.consume('chat-1', { turnId: 'turn-a' })).toBe(false);
  });

  it('clears only the rejected stop lifecycle', () => {
    const tracker = new ExpectedUserAbortTracker();
    tracker.mark('chat-1', { turnId: 'turn-a' }, 'stop-a');
    tracker.mark('chat-1', { turnId: 'turn-b' }, 'stop-b');
    tracker.clear('chat-1', 'stop-b');

    expect(tracker.consume('chat-1', { turnId: 'turn-b' })).toBe(false);
    expect(tracker.consume('chat-1', { turnId: 'turn-a' })).toBe('first');
  });
});
