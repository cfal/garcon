export interface SessionSocket {
  send(encoded: string): void;
  close(): void;
  canSend?(bytes: number): boolean;
}

export interface MessageSessionOptions {
  readonly deliver: (body: string) => void;
  readonly failed: (error: Error) => void;
  readonly availabilityChanged?: (connected: boolean) => void;
  readonly maxQueuedBytes?: number;
  readonly maxQueuedFrames?: number;
  readonly maxFrameBytes?: number;
  readonly budget?: MessageQueueBudget;
  readonly lane?: RpcLane;
}

export class MessageContinuityError extends Error {
  override readonly name = 'MessageContinuityError';
}

export class MessageSession {
  readonly #pending: { body: string; bytes: number; release: () => void }[] = [];
  readonly #limits;
  #bytes = 0;
  #socket: SessionSocket | null = null;
  #failure: Error | null = null;
  #flushing = false;
  #retry: ReturnType<typeof setTimeout> | null = null;
  #closedQueues: MessageQueueSnapshot | null = null;

  constructor(private readonly options: MessageSessionOptions) {
    this.#limits = {
      bytes: options.maxQueuedBytes ?? 32 * 1024 * 1024,
      count: options.maxQueuedFrames ?? 4096,
      frame: options.maxFrameBytes ?? 1024 * 1024,
    };
    for (const limit of Object.values(this.#limits)) {
      if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError('Session limits must be positive safe integers');
    }
  }

  get connected(): boolean { return this.#socket !== null; }
  // Why the session retired; recorded before its socket closes.
  get failure(): Error | null { return this.#failure; }
  get queuedBytes(): number { return this.#bytes; }
  get queuedFrames(): number { return this.#pending.length; }
  get queueSnapshot(): MessageQueueSnapshot | null { return this.#closedQueues ?? this.options.budget?.snapshot() ?? null; }

  fitsFrame(body: string): boolean { return Buffer.byteLength(body) <= this.#limits.frame; }

  canAdmit(body: string): boolean {
    const bytes = Buffer.byteLength(body);
    return this.connected && bytes <= this.#limits.frame && this.#bytes + bytes <= this.#limits.bytes
      && this.#pending.length < this.#limits.count
      && (this.options.budget?.canAdmit(this.options.lane ?? 'primary', bytes) ?? true);
  }

  offerBulkControl(frame: BulkConnectionControl): boolean {
    const body = JSON.stringify(frame);
    const bytes = Buffer.byteLength(body);
    const budget = this.options.budget;
    if (this.options.lane === 'bulk' || !budget || !this.connected || this.#failure
      || bytes > BULK_CONTROL_BYTES || bytes > this.#limits.frame
      || this.#bytes + bytes > this.#limits.bytes || this.#pending.length >= this.#limits.count
      || !budget.canAdmitControl(bytes)) return false;
    this.#enqueue(body, bytes, budget.reserveControl(bytes));
    return this.connected;
  }

  onCapacity(listener: () => void): () => void {
    return this.options.budget?.onCapacity(listener) ?? (() => {});
  }

  // Producer output fills at most its share of the queue, so RPC traffic is
  // never refused behind a replay. The caller keeps a refused frame and offers
  // it again as the queue drains; a frame larger than the share waits for an
  // empty queue.
  offer(body: string): boolean {
    if (!this.canAdmit(body)) return false;
    const exceedsShare = this.#bytes + Buffer.byteLength(body) > Math.min(this.#limits.bytes / 4, 4 * 1024 * 1024)
      || this.#pending.length >= Math.min(this.#limits.count / 4, 512);
    if (this.#pending.length > 0 && exceedsShare) return false;
    try { this.send(body); return this.connected; } catch { return false; }
  }

  // Terminal output yields capacity to RPC and producer events before admission.
  trySend(body: string): boolean {
    const bytes = Buffer.byteLength(body);
    if (!this.canAdmit(body)
      || this.#bytes + bytes > Math.min(this.#limits.bytes / 2, 2 * 1024 * 1024)
      || this.#pending.length >= Math.min(this.#limits.count / 2, 256)
      || this.#socket?.canSend?.(bytes) === false) return false;
    try { this.send(body); return this.connected; } catch { return false; }
  }

  send(body: string): void {
    if (this.#failure) throw this.#failure;
    if (!this.canAdmit(body)) {
      const error = new MessageContinuityError('Message queue unavailable or budget exhausted');
      this.close(error);
      throw error;
    }
    const bytes = Buffer.byteLength(body);
    this.#enqueue(body, bytes, this.options.budget?.reserve(this.options.lane ?? 'primary', bytes) ?? (() => {}));
    if (this.#failure) throw this.#failure;
  }

  #enqueue(body: string, bytes: number, release: () => void): void {
    this.#pending.push({ body, bytes, release });
    this.#bytes += bytes;
    this.#flush();
  }

  attach(socket: SessionSocket): { receive(encoded: string): void; disconnected(): void } {
    if (this.#failure) throw this.#failure;
    if (this.#socket) throw new Error('Message session already attached');
    this.#socket = socket;
    this.options.availabilityChanged?.(true);
    return {
      receive: (body) => {
        if (this.#socket !== socket) return;
        try {
          if (!this.fitsFrame(body)) throw new MessageContinuityError('Message exceeds frame budget');
          this.options.deliver(body);
        } catch (error) { this.close(error instanceof Error ? error : new Error(String(error))); }
      },
      disconnected: () => this.close(new MessageContinuityError('Executor connection lost')),
    };
  }

  close(error: Error = new MessageContinuityError('Message session closed')): void {
    if (this.#failure) return;
    this.#closedQueues = this.options.budget?.snapshot() ?? null;
    this.#failure = error;
    const socket = this.#socket;
    this.#socket = null;
    if (this.#retry) clearTimeout(this.#retry);
    this.#retry = null;
    for (const pending of this.#pending) pending.release();
    this.#pending.length = 0;
    this.#bytes = 0;
    socket?.close();
    this.options.availabilityChanged?.(false);
    this.options.failed(error);
  }

  #flush(): void {
    if (this.#flushing) return;
    this.#flushing = true;
    try {
      while (this.#socket && this.#pending.length) {
        const message = this.#pending[0]!;
        if (this.#socket.canSend?.(message.bytes) === false) {
          if (!this.#retry) {
            this.#retry = setTimeout(() => { this.#retry = null; this.#flush(); }, 10);
            this.#retry.unref();
          }
          return;
        }
        this.#pending.shift();
        this.#bytes -= message.bytes;
        message.release();
        this.#socket.send(message.body);
      }
    } catch (error) { this.close(error instanceof Error ? error : new Error(String(error))); }
    finally { this.#flushing = false; }
  }
}
import type { MessageQueueBudget, MessageQueueSnapshot } from './message-queue-budget.js';
import type { BulkConnectionControl, RpcLane } from './rpc-lane.js';
import { BULK_CONTROL_BYTES } from './limits.js';
