import { describe, expect, it } from 'bun:test';
import { ExpectedUserAbortTracker } from '../expected-user-aborts.js';

describe('ExpectedUserAbortTracker', () => {
  it('consumes only terminal events for the interrupted turn', () => {
    const tracker = new ExpectedUserAbortTracker();
    tracker.mark('chat-1', { turnId: 'turn-a', clientRequestId: 'req-a' }, 'stop-a');
    tracker.acknowledge('chat-1', 'stop-a', true);

    expect(tracker.consume('chat-1', { turnId: 'turn-b', clientRequestId: 'req-b' })).toBe(false);
    expect(tracker.consume('chat-1', { turnId: 'turn-a' })).toBe('first');
  });

  it('suppresses duplicate terminal channels for the same identified turn', () => {
    const tracker = new ExpectedUserAbortTracker();
    tracker.mark('chat-1', { turnId: 'turn-a' }, 'stop-a');
    tracker.acknowledge('chat-1', 'stop-a', true);

    expect(tracker.consume('chat-1', { turnId: 'turn-a' })).toBe('first');
    expect(tracker.consume('chat-1', { turnId: 'turn-a' })).toBe('duplicate');
  });

  it('does not let a consumed identityless marker swallow a later failure', () => {
    const tracker = new ExpectedUserAbortTracker();
    tracker.mark('chat-1', {}, 'stop-a');
    tracker.acknowledge('chat-1', 'stop-a', true);

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
    tracker.acknowledge('chat-1', 'stop-a', true);
    tracker.acknowledge('chat-1', 'stop-b', true);

    expect(tracker.consume('chat-1')).toBe('first');
    expect(tracker.consume('chat-1')).toBe(false);
  });

  it('retains independent expectations for overlapping stopped turns', () => {
    const tracker = new ExpectedUserAbortTracker();
    tracker.mark('chat-1', { turnId: 'turn-a' }, 'stop-a');
    tracker.mark('chat-1', { turnId: 'turn-b' }, 'stop-b');
    tracker.acknowledge('chat-1', 'stop-a', true);
    tracker.acknowledge('chat-1', 'stop-b', true);

    expect(tracker.consume('chat-1', { turnId: 'turn-a' })).toBe('first');
    expect(tracker.consume('chat-1', { turnId: 'turn-b' })).toBe('first');
  });

  it('retains identified abort expectations until their terminal arrives', () => {
    let now = 1000;
    const tracker = new ExpectedUserAbortTracker({ ttlMs: 100, now: () => now });
    tracker.mark('chat-1', { turnId: 'turn-a' }, 'stop-a');
    tracker.acknowledge('chat-1', 'stop-a', true);
    now = 1101;

    expect(tracker.consume('chat-1', { turnId: 'turn-a' })).toBe('first');
  });

  it('retires identified expectations when their queue-owned turn settles', () => {
    const tracker = new ExpectedUserAbortTracker();
    tracker.mark('chat-1', { turnId: 'turn-a' }, 'stop-a');
    tracker.mark('chat-1', { turnId: 'turn-b' }, 'stop-b');
    tracker.acknowledge('chat-1', 'stop-a', true);
    tracker.acknowledge('chat-1', 'stop-b', true);
    expect(tracker.consume('chat-1', { turnId: 'turn-a' })).toBe('first');

    tracker.completeTurn('chat-1', { turnId: 'turn-a' });

    expect(tracker.consume('chat-1', { turnId: 'turn-a' })).toBe(false);
    expect(tracker.consume('chat-1', { turnId: 'turn-b' })).toBe('first');
  });

  it('does not retire any expectation at an identityless turn boundary', () => {
    const tracker = new ExpectedUserAbortTracker();
    tracker.mark('chat-1', {}, 'stop-unscoped');
    tracker.mark('chat-1', { turnId: 'turn-a' }, 'stop-a');
    tracker.acknowledge('chat-1', 'stop-unscoped', true);
    tracker.acknowledge('chat-1', 'stop-a', true);

    tracker.completeTurn('chat-1');

    expect(tracker.consume('chat-1')).toBe('first');
    expect(tracker.consume('chat-1', { turnId: 'turn-a' })).toBe('first');
  });

  it('expires old identityless abort expectations', () => {
    let now = 1000;
    const tracker = new ExpectedUserAbortTracker({ ttlMs: 100, now: () => now });
    tracker.mark('chat-1', {}, 'stop-a');
    tracker.acknowledge('chat-1', 'stop-a', true);
    now = 1101;

    expect(tracker.consume('chat-1')).toBe(false);
  });

  it('retains an identityless expectation while acknowledgement is pending', () => {
    let now = 1000;
    const tracker = new ExpectedUserAbortTracker({ ttlMs: 100, now: () => now });
    tracker.mark('chat-1', {}, 'stop-a');
    now = 1101;

    expect(tracker.consume('chat-1')).toBe('deferred');
    expect(tracker.acknowledge('chat-1', 'stop-a', false).disposition).toBe('release');
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
    tracker.acknowledge('chat-1', 'stop-a', true);

    expect(tracker.consume('chat-1', { turnId: 'turn-b' })).toBe(false);
    expect(tracker.consume('chat-1', { turnId: 'turn-a' })).toBe('first');
  });

  it('defers a terminal until the stop acknowledgement is known', () => {
    const tracker = new ExpectedUserAbortTracker();
    tracker.mark('chat-1', { turnId: 'turn-a' }, 'stop-a');

    expect(tracker.consume('chat-1', { turnId: 'turn-a' })).toBe('deferred');
    expect(tracker.acknowledge('chat-1', 'stop-a', true)).toEqual({
      disposition: 'suppress',
      identity: { turnId: 'turn-a' },
    });
  });

  it('releases a deferred terminal when the stop is rejected', () => {
    const tracker = new ExpectedUserAbortTracker();
    tracker.mark('chat-1', { turnId: 'turn-a' }, 'stop-a');
    tracker.consume('chat-1', { turnId: 'turn-a' });
    tracker.completeTurn('chat-1', { turnId: 'turn-a' });

    expect(tracker.acknowledge('chat-1', 'stop-a', false)).toEqual({
      disposition: 'release',
      identity: { turnId: 'turn-a' },
    });
    expect(tracker.consume('chat-1', { turnId: 'turn-a' })).toBe(false);
  });

  it('waits for every overlapping stop to reject before releasing a terminal', () => {
    const tracker = new ExpectedUserAbortTracker();
    tracker.mark('chat-1', { turnId: 'turn-a' }, 'stop-a');
    tracker.mark('chat-1', { turnId: 'turn-a' }, 'stop-b');
    expect(tracker.consume('chat-1', { turnId: 'turn-a' })).toBe('deferred');

    expect(tracker.acknowledge('chat-1', 'stop-a', false).disposition).toBe('none');
    expect(tracker.acknowledge('chat-1', 'stop-b', false).disposition).toBe('release');
  });
});
