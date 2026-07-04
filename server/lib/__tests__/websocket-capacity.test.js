import { describe, expect, it } from 'bun:test';
import { shouldRejectWebSocketUpgrade } from '../websocket-capacity.ts';

describe('shouldRejectWebSocketUpgrade', () => {
  it('rejects before upgrade when the next socket would exceed capacity', () => {
    expect(shouldRejectWebSocketUpgrade(9, 10)).toBe(false);
    expect(shouldRejectWebSocketUpgrade(10, 10)).toBe(true);
  });

  it('rejects unusable capacity limits', () => {
    expect(shouldRejectWebSocketUpgrade(0, 0)).toBe(true);
    expect(shouldRejectWebSocketUpgrade(0, Number.NaN)).toBe(true);
  });
});

