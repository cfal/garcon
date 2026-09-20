import type { ServerWebSocket } from 'bun';
import type { ServerPrincipal } from '../lib/http-route-types.js';
import type { WebSocketMessagePublisher } from './transport.js';

export interface PrimaryWebSocketData {
  connectionId: string;
  principal: ServerPrincipal;
}

type NativeSocket = Pick<ServerWebSocket<PrimaryWebSocketData>,
  'data' | 'readyState' | 'send' | 'subscribe' | 'isSubscribed' | 'close' | 'terminate' | 'getBufferedAmount'>;

export type PrimaryWebSocket = Pick<NativeSocket, 'data' | 'readyState' | 'subscribe' | 'close'> & {
  send(payload: string, compress?: boolean): number;
};

class BoundedPrimarySocket implements PrimaryWebSocket {
  #closed = false;

  constructor(readonly native: NativeSocket, readonly backpressureLimit: number) {}

  get data() { return this.native.data; }
  get readyState() { return this.#closed ? 3 : this.native.readyState; }

  subscribe(topic: string): boolean { return this.native.subscribe(topic); }

  send(payload: string, compress?: boolean): number {
    if (this.readyState !== 1) return 0;
    const status = this.native.send(payload, compress);
    // Bun's native limit is shared with Noise; browser queues retain their own budget.
    if (this.native.getBufferedAmount() > this.backpressureLimit) {
      this.retire();
      this.native.terminate();
      return 0;
    }
    return status;
  }

  close(code?: number, reason?: string): void {
    if (this.#closed) return;
    this.retire();
    this.native.close(code, reason);
  }

  retire(): void { this.#closed = true; }
}

export class PrimarySocketDelivery implements WebSocketMessagePublisher {
  readonly #sockets = new Map<NativeSocket, BoundedPrimarySocket>();

  constructor(readonly backpressureLimit: number) {}

  add(socket: NativeSocket): PrimaryWebSocket {
    const peer = new BoundedPrimarySocket(socket, this.backpressureLimit);
    this.#sockets.set(socket, peer);
    return peer;
  }

  get(socket: NativeSocket): PrimaryWebSocket | undefined { return this.#sockets.get(socket); }

  remove(socket: NativeSocket): PrimaryWebSocket | undefined {
    const peer = this.#sockets.get(socket);
    peer?.retire();
    this.#sockets.delete(socket);
    return peer;
  }

  publish(topic: string, payload: string, compress?: boolean): number {
    let sentBytes = 0;
    let queued = false;
    for (const [socket, peer] of this.#sockets) {
      if (peer.readyState !== 1 || !socket.isSubscribed(topic)) continue;
      const status = peer.send(payload, compress);
      if (status > 0) sentBytes += status;
      else if (status === -1) queued = true;
    }
    return sentBytes || (queued ? -1 : 0);
  }
}
