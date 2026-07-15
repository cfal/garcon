export function shouldRejectWebSocketUpgrade(pendingWebSockets: number, maxWebSocketClients: number): boolean {
  if (!Number.isFinite(maxWebSocketClients) || maxWebSocketClients < 1) return true;
  return pendingWebSockets >= maxWebSocketClients;
}

export type AdmittedWebSocketPath = '/ws' | '/shell';
export type WebSocketAdmissionRejection =
  | 'hard-capacity'
  | 'terminal-stream-capacity'
  | 'duplicate-connection'
  | 'unknown-reservation'
  | 'pathname-mismatch';

export type WebSocketAdmissionResult =
  | { ok: true }
  | { ok: false; reason: WebSocketAdmissionRejection };

interface Reservation {
  pathname: AdmittedWebSocketPath;
  status: 'pending' | 'active';
}

export class WebSocketAdmissionController {
  readonly #reservations = new Map<string, Reservation>();

  constructor(
    readonly maxConnections: number,
    readonly reservedChatSlots: number,
  ) {
    if (!Number.isInteger(maxConnections) || maxConnections < 1) {
      throw new RangeError('WebSocket maximum must be a positive integer');
    }
    if (!Number.isInteger(reservedChatSlots) || reservedChatSlots < 1 || reservedChatSlots > maxConnections) {
      throw new RangeError('Reserved Chat slots must be within the WebSocket maximum');
    }
  }

  get size(): number {
    return this.#reservations.size;
  }

  tryReserve(connectionId: string, pathname: AdmittedWebSocketPath): WebSocketAdmissionResult {
    if (this.#reservations.has(connectionId)) return { ok: false, reason: 'duplicate-connection' };
    if (this.#reservations.size >= this.maxConnections) return { ok: false, reason: 'hard-capacity' };
    if (pathname === '/shell' && this.#reservations.size >= this.maxConnections - this.reservedChatSlots) {
      return { ok: false, reason: 'terminal-stream-capacity' };
    }
    this.#reservations.set(connectionId, { pathname, status: 'pending' });
    return { ok: true };
  }

  confirm(connectionId: string, pathname: AdmittedWebSocketPath): WebSocketAdmissionResult {
    const reservation = this.#reservations.get(connectionId);
    if (!reservation) return { ok: false, reason: 'unknown-reservation' };
    if (reservation.pathname !== pathname) {
      this.#reservations.delete(connectionId);
      return { ok: false, reason: 'pathname-mismatch' };
    }
    reservation.status = 'active';
    return { ok: true };
  }

  release(connectionId: string): boolean {
    return this.#reservations.delete(connectionId);
  }
}
