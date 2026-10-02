export type WebSocketAdmissionRejection =
  | 'hard-capacity'
  | 'duplicate-connection'
  | 'unknown-reservation';

export type WebSocketAdmissionResult =
  | { ok: true }
  | { ok: false; reason: WebSocketAdmissionRejection };

export class WebSocketAdmissionController {
  readonly #reservations = new Set<string>();

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
    this.#reservations.add(connectionId);
    return { ok: true };
  }

  confirm(connectionId: string): WebSocketAdmissionResult {
    if (!this.#reservations.has(connectionId)) return { ok: false, reason: 'unknown-reservation' };
    return { ok: true };
  }

  release(connectionId: string): boolean {
    return this.#reservations.delete(connectionId);
  }
}
