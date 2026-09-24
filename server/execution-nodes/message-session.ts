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
}

export class MessageContinuityError extends Error {
  override readonly name = 'MessageContinuityError';
}

export class MessageSession {
  readonly #pending: { body: string; bytes: number }[] = [];
  readonly #limits;
  #bytes = 0;
  #socket: SessionSocket | null = null;
  #failure: Error | null = null;
  #flushing = false;
  #retry: ReturnType<typeof setTimeout> | null = null;

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
  get queuedBytes(): number { return this.#bytes; }
  get queuedFrames(): number { return this.#pending.length; }

  fitsFrame(body: string): boolean { return Buffer.byteLength(body) <= this.#limits.frame; }

  canAdmit(body: string): boolean {
    const bytes = Buffer.byteLength(body);
    return this.connected && bytes <= this.#limits.frame && this.#bytes + bytes <= this.#limits.bytes
      && this.#pending.length < this.#limits.count;
  }

  // Terminal output yields capacity to RPC and producer events before admission.
  trySend(body: string): boolean {
    const bytes = Buffer.byteLength(body);
    if (!this.connected || bytes > this.#limits.frame
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
    this.#pending.push({ body, bytes });
    this.#bytes += bytes;
    this.#flush();
    if (this.#failure) throw this.#failure;
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
      disconnected: () => this.close(new MessageContinuityError('Execution-node connection lost')),
    };
  }

  close(error: Error = new MessageContinuityError('Message session closed')): void {
    if (this.#failure) return;
    this.#failure = error;
    const socket = this.#socket;
    this.#socket = null;
    if (this.#retry) clearTimeout(this.#retry);
    this.#retry = null;
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
        this.#socket.send(message.body);
      }
    } catch (error) { this.close(error instanceof Error ? error : new Error(String(error))); }
    finally { this.#flushing = false; }
  }
}
