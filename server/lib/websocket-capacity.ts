export type WebSocketAdmissionRejection =
  | 'hard-capacity'
  | 'duplicate-connection'
  | 'unknown-reservation';

export type WebSocketAdmissionResult =
  | { ok: true }
  | { ok: false; reason: WebSocketAdmissionRejection };

interface Reservation {
  status: 'pending' | 'active';
}

export class WebSocketAdmissionController {
  readonly #reservations = new Map<string, Reservation>();

  constructor(readonly maxConnections: number) {
    if (!Number.isInteger(maxConnections) || maxConnections < 1) {
      throw new RangeError('WebSocket maximum must be a positive integer');
    }
  }

  get size(): number {
    return this.#reservations.size;
  }

  tryReserve(connectionId: string): WebSocketAdmissionResult {
    if (this.#reservations.has(connectionId)) return { ok: false, reason: 'duplicate-connection' };
    if (this.#reservations.size >= this.maxConnections) return { ok: false, reason: 'hard-capacity' };
    this.#reservations.set(connectionId, { status: 'pending' });
    return { ok: true };
  }

  confirm(connectionId: string): WebSocketAdmissionResult {
    const reservation = this.#reservations.get(connectionId);
    if (!reservation) return { ok: false, reason: 'unknown-reservation' };
    reservation.status = 'active';
    return { ok: true };
  }

  release(connectionId: string): boolean {
    return this.#reservations.delete(connectionId);
  }
}
