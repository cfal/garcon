import { describe, expect, it } from 'bun:test';
import { WebSocketAdmissionController } from '../websocket-capacity.ts';

describe('WebSocketAdmissionController', () => {
  it('admits primary sockets up to the hard limit', () => {
    const admission = new WebSocketAdmissionController(2);

    expect(admission.tryReserve('socket-1')).toEqual({ ok: true });
    expect(admission.tryReserve('socket-2')).toEqual({ ok: true });
    expect(admission.tryReserve('socket-3')).toEqual({
      ok: false,
      reason: 'hard-capacity',
    });
  });

  it('tracks pending and active reservations with exact release semantics', () => {
    const admission = new WebSocketAdmissionController(3);

    expect(admission.tryReserve('socket-1')).toEqual({ ok: true });
    expect(admission.tryReserve('socket-1')).toEqual({
      ok: false,
      reason: 'duplicate-connection',
    });
    expect(admission.confirm('missing')).toEqual({
      ok: false,
      reason: 'unknown-reservation',
    });
    expect(admission.confirm('socket-1')).toEqual({ ok: true });
    expect(admission.size).toBe(1);
    expect(admission.release('socket-1')).toBe(true);
  });

  it('releases failed upgrades so later reservations can proceed', () => {
    const admission = new WebSocketAdmissionController(1);

    expect(admission.tryReserve('failed')).toEqual({ ok: true });
    expect(admission.release('failed')).toBe(true);
    expect(admission.tryReserve('next')).toEqual({ ok: true });
    expect(admission.confirm('next')).toEqual({ ok: true });
    expect(admission.release('next')).toBe(true);
    expect(admission.release('next')).toBe(false);
  });

  it('rejects invalid capacity limits', () => {
    expect(() => new WebSocketAdmissionController(0)).toThrow(RangeError);
    expect(() => new WebSocketAdmissionController(Number.NaN)).toThrow(RangeError);
  });
});
