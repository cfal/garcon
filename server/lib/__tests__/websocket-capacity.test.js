import { describe, expect, it } from 'bun:test';
import {
  shouldRejectWebSocketUpgrade,
  WebSocketAdmissionController,
} from '../websocket-capacity.ts';

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

describe('WebSocketAdmissionController', () => {
  it('preserves reserved Chat capacity while admitting terminal streams', () => {
    const admission = new WebSocketAdmissionController(4, 1);

    expect(admission.tryReserve('terminal-1', '/shell')).toEqual({ ok: true });
    expect(admission.tryReserve('terminal-2', '/shell')).toEqual({ ok: true });
    expect(admission.tryReserve('terminal-3', '/shell')).toEqual({ ok: true });
    expect(admission.tryReserve('terminal-4', '/shell')).toEqual({
      ok: false,
      reason: 'terminal-stream-capacity',
    });
    expect(admission.tryReserve('chat-1', '/ws')).toEqual({ ok: true });
    expect(admission.tryReserve('chat-2', '/ws')).toEqual({ ok: false, reason: 'hard-capacity' });
  });

  it('disables terminal admission when one slot is reserved from a one-slot limit', () => {
    const admission = new WebSocketAdmissionController(1, 1);

    expect(admission.tryReserve('terminal-1', '/shell')).toEqual({
      ok: false,
      reason: 'terminal-stream-capacity',
    });
    expect(admission.tryReserve('chat-1', '/ws')).toEqual({ ok: true });
  });

  it('tracks pending and active reservations with exact release semantics', () => {
    const admission = new WebSocketAdmissionController(3, 1);

    expect(admission.tryReserve('socket-1', '/shell')).toEqual({ ok: true });
    expect(admission.tryReserve('socket-1', '/shell')).toEqual({
      ok: false,
      reason: 'duplicate-connection',
    });
    expect(admission.confirm('missing', '/ws')).toEqual({
      ok: false,
      reason: 'unknown-reservation',
    });
    expect(admission.confirm('socket-1', '/ws')).toEqual({
      ok: false,
      reason: 'pathname-mismatch',
    });
    expect(admission.size).toBe(0);
    expect(admission.release('socket-1')).toBe(false);
  });

  it('releases failed upgrades so later reservations can proceed', () => {
    const admission = new WebSocketAdmissionController(2, 1);

    expect(admission.tryReserve('failed', '/shell')).toEqual({ ok: true });
    expect(admission.release('failed')).toBe(true);
    expect(admission.tryReserve('next', '/shell')).toEqual({ ok: true });
    expect(admission.confirm('next', '/shell')).toEqual({ ok: true });
    expect(admission.release('next')).toBe(true);
    expect(admission.release('next')).toBe(false);
  });
});
