export interface NodeSocketPort {
  readonly open: boolean;
  readonly bufferedBytes: number;
  bufferedFrameBytes(payloadBytes: number): number;
  send(serialized: string): boolean;
  terminate(): void;
}

export interface NodeSocketWriterOptions {
  readonly signal: AbortSignal;
  readonly maxFrameBytes: number;
  readonly maxBufferedBytes: number;
  readonly reservedControlBytes: number;
  readonly reservedLifecycleBytes: number;
  readonly maxDrainWaiters: number;
  /** Bounds any observed native backlog, including automatic protocol replies on an idle channel. */
  readonly drainTimeoutMs: number;
  readonly now?: () => number;
  readonly schedulePoll?: (callback: () => void, delayMs: number) => { cancel(): void };
}

// Bun queues automatic pongs outside application admission; their backlog remains bounded separately.
export const NODE_SOCKET_PROTOCOL_ALLOWANCE_BYTES = 16 * 1024;

interface DrainWaiter {
  readonly throughBytes: number;
  readonly result: PromiseWithResolvers<void>;
  readonly detach: () => void;
}

export class NodeSocketWriteError extends Error {
  constructor(readonly code: 'NODE_SOCKET_CLOSED' | 'NODE_SOCKET_CAPACITY' | 'NODE_SOCKET_INVALID_ACCOUNTING' | 'NODE_SOCKET_BACKPRESSURE') {
    super(code === 'NODE_SOCKET_CAPACITY' ? 'Node socket capacity exceeded' : 'Node socket delivery is unavailable');
    this.name = 'NodeSocketWriteError';
  }
}

/** Bounds one physical socket independently of replay storage or logical execution authority. */
export class NodeSocketWriter {
  readonly #waiters = new Set<DrainWaiter>();
  readonly #detach: () => void;
  #failure: NodeSocketWriteError | null = null;
  #timer: { cancel(): void } | null = null;
  #pollDelayMs = 0;
  #drainDeadline: number | null = null;
  #lastTime = 0;
  #lastBuffered = 0;

  constructor(private readonly port: NodeSocketPort, private readonly options: NodeSocketWriterOptions) {
    for (const value of [options.maxFrameBytes, options.maxBufferedBytes, options.reservedControlBytes, options.reservedLifecycleBytes,
      options.maxDrainWaiters, options.drainTimeoutMs]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('Invalid node socket limits');
    }
    const frameBytes = port.bufferedFrameBytes(options.maxFrameBytes);
    if (!Number.isSafeInteger(options.maxBufferedBytes + NODE_SOCKET_PROTOCOL_ALLOWANCE_BYTES)
      || !Number.isSafeInteger(frameBytes) || frameBytes < options.maxFrameBytes
      || options.reservedLifecycleBytes > options.reservedControlBytes
      || frameBytes > options.maxBufferedBytes - options.reservedControlBytes) throw new TypeError('Node frame limit exceeds data capacity');
    this.options = Object.freeze({ ...options });
    const close = () => this.close();
    options.signal.addEventListener('abort', close, { once: true });
    this.#detach = () => options.signal.removeEventListener('abort', close);
    if (options.signal.aborted) this.close();
    else this.#schedule();
  }

  /** Refuses a control frame without delivery when the healthy native queue has insufficient headroom. */
  send(serialized: string): boolean {
    return this.#send(serialized, 0);
  }

  /** Admits data synchronously while preserving the physical control reserve. */
  sendData(serialized: string): boolean {
    return this.#send(serialized, this.options.reservedControlBytes);
  }

  sendApplication(serialized: string): boolean {
    return this.#send(serialized, this.options.reservedLifecycleBytes);
  }

  #send(serialized: string, reservedBytes: number): boolean {
    const buffered = this.#observeBuffer();
    const length = Buffer.byteLength(serialized);
    if (length > this.options.maxFrameBytes) throw new NodeSocketWriteError('NODE_SOCKET_CAPACITY');
    if (this.#frameBytes(length) > this.options.maxBufferedBytes - reservedBytes - buffered) return false;
    try {
      if (!this.port.send(serialized)) throw new NodeSocketWriteError('NODE_SOCKET_CLOSED');
      this.#observeBuffer();
    } catch {
      this.close();
      throw this.#failure;
    }
    return true;
  }

  sendWhenWritable(serialized: string, signal: AbortSignal, validate: () => void): Promise<void> {
    return this.#sendWhenWritable(serialized, signal, validate, this.options.reservedControlBytes);
  }

  sendApplicationWhenWritable(serialized: string, signal: AbortSignal, validate: () => void): Promise<void> {
    return this.#sendWhenWritable(serialized, signal, validate, this.options.reservedLifecycleBytes);
  }

  async #sendWhenWritable(serialized: string, signal: AbortSignal, validate: () => void, reservedBytes: number): Promise<void> {
    signal.throwIfAborted();
    const length = Buffer.byteLength(serialized);
    if (length > this.options.maxFrameBytes) throw new NodeSocketWriteError('NODE_SOCKET_CAPACITY');
    const throughBytes = this.options.maxBufferedBytes - reservedBytes - this.#frameBytes(length);
    while (true) {
      signal.throwIfAborted();
      validate();
      signal.throwIfAborted();
      if (this.#send(serialized, reservedBytes)) return;
      await this.#waitForBuffer(throughBytes, signal);
    }
  }

  drained(signal: AbortSignal): Promise<void> { return this.#waitForBuffer(0, signal); }

  /** Leaves room for the next bounded data frame without requiring unrelated control traffic to stop. */
  writable(signal: AbortSignal): Promise<void> {
    return this.#waitForBuffer(this.options.maxBufferedBytes - this.options.reservedControlBytes
      - this.#frameBytes(this.options.maxFrameBytes), signal);
  }

  async #waitForBuffer(throughBytes: number, signal: AbortSignal): Promise<void> {
    this.#assertOpen();
    signal.throwIfAborted();
    if (this.#observeBuffer() <= throughBytes) return;
    if (this.#waiters.size >= this.options.maxDrainWaiters) throw new NodeSocketWriteError('NODE_SOCKET_CAPACITY');
    const cancel = () => this.#settle(waiter, signal.reason);
    const waiter: DrainWaiter = { throughBytes, result: Promise.withResolvers<void>(), detach: () => signal.removeEventListener('abort', cancel) };
    this.#waiters.add(waiter);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    this.#schedule();
    return waiter.result.promise;
  }

  /** Called by server-side drain events; client sockets use the bounded poll fallback. */
  drain(): void {
    if (this.#failure) return;
    try { this.#observeBuffer(); } catch { this.close(); }
  }

  close(): void { this.#fail(new NodeSocketWriteError('NODE_SOCKET_CLOSED')); }

  #assertOpen(): void {
    if (!this.port.open || this.options.signal.aborted) this.close();
    if (this.#failure) throw this.#failure;
  }

  #bufferedBytes(): number {
    const bytes = this.port.bufferedBytes;
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      this.#fail(new NodeSocketWriteError('NODE_SOCKET_INVALID_ACCOUNTING'));
      throw this.#failure;
    }
    if (bytes > this.options.maxBufferedBytes + NODE_SOCKET_PROTOCOL_ALLOWANCE_BYTES) {
      this.#fail(new NodeSocketWriteError('NODE_SOCKET_BACKPRESSURE'));
      throw this.#failure;
    }
    return bytes;
  }

  #frameBytes(length: number): number {
    const bytes = this.port.bufferedFrameBytes(length);
    if (!Number.isSafeInteger(bytes) || bytes < length) {
      this.#fail(new NodeSocketWriteError('NODE_SOCKET_INVALID_ACCOUNTING'));
      throw this.#failure;
    }
    return bytes;
  }

  #observeBuffer(): number {
    this.#assertOpen();
    const now = this.#now();
    const buffered = this.#bufferedBytes();
    if (buffered) {
      if (buffered < this.#lastBuffered) this.#drainDeadline = now + this.options.drainTimeoutMs;
      if (this.#drainDeadline !== null && now >= this.#drainDeadline) {
        this.close();
        throw this.#failure;
      }
      this.#drainDeadline ??= now + this.options.drainTimeoutMs;
    } else {
      this.#drainDeadline = null;
    }
    this.#lastBuffered = buffered;
    for (const waiter of this.#waiters) if (buffered <= waiter.throughBytes) this.#settle(waiter);
    this.#schedule();
    return buffered;
  }

  #now(): number {
    const now = (this.options.now ?? (() => performance.now()))();
    if (!Number.isFinite(now) || now < this.#lastTime) this.close();
    this.#assertOpen();
    this.#lastTime = now;
    return now;
  }

  #settle(waiter: DrainWaiter, error?: unknown): void {
    if (!this.#waiters.delete(waiter)) return;
    waiter.detach();
    if (error === undefined) waiter.result.resolve();
    else waiter.result.reject(error);
  }

  #fail(error: NodeSocketWriteError): void {
    if (this.#failure) return;
    this.#failure = error;
    this.#detach();
    this.#timer?.cancel();
    this.#timer = null;
    this.#drainDeadline = null;
    for (const waiter of this.#waiters) this.#settle(waiter, error);
    try { this.port.terminate(); } catch { /* A failed socket cannot regain delivery authority. */ }
  }

  #schedule(): void {
    // Native protocol traffic may queue even when the application has never written a frame.
    if (this.#failure) return;
    const delayMs = this.#lastBuffered === 0 ? 100 : 10;
    if (this.#timer) {
      if (this.#pollDelayMs <= delayMs) return;
      this.#timer.cancel();
    }
    this.#pollDelayMs = delayMs;
    this.#timer = (this.options.schedulePoll ?? schedulePoll)(() => {
      this.#timer = null;
      this.drain();
      this.#schedule();
    }, delayMs);
  }
}

function schedulePoll(callback: () => void, delayMs: number): { cancel(): void } {
  const timer = setTimeout(callback, delayMs);
  timer.unref();
  return { cancel: () => clearTimeout(timer) };
}
