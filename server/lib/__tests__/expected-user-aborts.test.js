import { describe, it, expect } from 'bun:test';
import { ExpectedUserAbortTracker } from '../expected-user-aborts.js';

describe('ExpectedUserAbortTracker', () => {
  it('tracks a recently requested user abort', () => {
    let now = 1000;
    const tracker = new ExpectedUserAbortTracker({ ttlMs: 100, now: () => now });

    tracker.mark('chat-1');

    expect(tracker.has('chat-1')).toBe(true);
    now = 1099;
    expect(tracker.has('chat-1')).toBe(true);
  });

  it('expires old abort markers', () => {
    let now = 1000;
    const tracker = new ExpectedUserAbortTracker({ ttlMs: 100, now: () => now });

    tracker.mark('chat-1');
    now = 1101;

    expect(tracker.has('chat-1')).toBe(false);
  });

  it('clears abort markers for later real turns', () => {
    const tracker = new ExpectedUserAbortTracker();

    tracker.mark('chat-1');
    tracker.clear('chat-1');

    expect(tracker.has('chat-1')).toBe(false);
  });
});
