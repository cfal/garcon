import { encodeNodeWorkerFrame, NODE_WORKER_FRAME_HEADER_BYTES, NodeWorkerTransportError } from './framing.js';

export type NodeWorkerFramePriority = 'control' | 'urgent' | 'data';

export interface NodeWorkerWritePort {
  /** Settles only after these bytes have left the local stream buffer. */
  write(bytes: Uint8Array): Promise<void>;
  close(): void;
}

export interface NodeWorkerWriterOptions {
  readonly signal: AbortSignal;
  readonly maxFrameBytes: number;
  readonly maxQueuedBytes: number;
  readonly maxQueuedFrames: number;
  readonly reservedControlBytes: number;
  readonly reservedControlFrames: number;
  readonly reservedUrgentBytes?: number;
  readonly reservedUrgentFrames?: number;
  readonly writeTimeoutMs: number;
  readonly scheduleTimeout?: (callback: () => void, delayMs: number) => { cancel(): void };
  failed(error: NodeWorkerTransportError): void;
}

export interface NodeWorkerWriteAuthority {
  readonly signal: AbortSignal;
  validate(): void;
}

export interface NodeFrameSubmission {
  /** True once native submission begins; a native failure may have written only part of the frame. */
  readonly submitted: boolean;
  /** Null when the transport exposes only synchronous admission; rejection does not prove native settlement. */
  readonly drained: Promise<void> | null;
}

export interface NodeFrameWriter {
  submit(text: string, priority: NodeWorkerFramePriority, authority: NodeWorkerWriteAuthority): NodeFrameSubmission;
}

export interface NodeWorkerSubmission extends NodeFrameSubmission {
  readonly drained: Promise<void>;
}

interface PendingFrame {
  readonly bytes: Uint8Array;
  readonly priority: NodeWorkerFramePriority;
  readonly result: PromiseWithResolvers<void>;
  readonly authority: NodeWorkerWriteAuthority;
  readonly detach: () => void;
  submitted: boolean;
}

/** Reserves lifecycle capacity and serializes native writes without releasing in-flight memory early. */
export class NodeWorkerWriter {
  readonly #control: PendingFrame[] = [];
  readonly #urgent: PendingFrame[] = [];
  readonly #data: PendingFrame[] = [];
  readonly #waiting = new Set<(error?: unknown) => void>();
  readonly #detach: () => void;
  #current: PendingFrame | null = null;
  #failure: NodeWorkerTransportError | null = null;
  #timer: { cancel(): void } | null = null;
  #bytes = 0;
  #frames = 0;
  #applicationBytes = 0;
  #applicationFrames = 0;
  #dataBytes = 0;
  #dataFrames = 0;

  constructor(private readonly port: NodeWorkerWritePort, private readonly options: NodeWorkerWriterOptions) {
    const { maxFrameBytes, maxQueuedBytes, maxQueuedFrames, reservedControlBytes, reservedControlFrames, writeTimeoutMs } = options;
    const { reservedUrgentBytes = 0, reservedUrgentFrames = 0 } = options;
    if (![maxFrameBytes, maxQueuedBytes, maxQueuedFrames, reservedControlBytes, reservedControlFrames, writeTimeoutMs]
      .every((value) => Number.isSafeInteger(value) && value > 0)
      || ![reservedUrgentBytes, reservedUrgentFrames].every((value) => Number.isSafeInteger(value) && value >= 0)
      || maxFrameBytes > 0xffff_ffff || maxFrameBytes + NODE_WORKER_FRAME_HEADER_BYTES > maxQueuedBytes - reservedControlBytes - reservedUrgentBytes
      || reservedControlFrames >= maxQueuedFrames - reservedUrgentFrames) throw new TypeError('Invalid worker writer limits');
    this.options = Object.freeze({ ...options });
    const close = () => this.close();
    options.signal.addEventListener('abort', close, { once: true });
    this.#detach = () => options.signal.removeEventListener('abort', close);
    if (options.signal.aborted) this.close();
  }

  async send(text: string, priority: NodeWorkerFramePriority): Promise<void> {
    return this.submit(text, priority, { signal: this.options.signal, validate() {} }).drained;
  }

  submit(text: string, priority: NodeWorkerFramePriority, authority: NodeWorkerWriteAuthority): NodeWorkerSubmission {
    if (this.#failure) throw this.#failure;
    authority.signal.throwIfAborted();
    const size = Buffer.byteLength(text) + NODE_WORKER_FRAME_HEADER_BYTES;
    if (size > this.options.maxFrameBytes + NODE_WORKER_FRAME_HEADER_BYTES || size === NODE_WORKER_FRAME_HEADER_BYTES) {
      throw new NodeWorkerTransportError('NODE_WORKER_PROTOCOL');
    }
    if (this.#frames >= this.options.maxQueuedFrames || size > this.options.maxQueuedBytes - this.#bytes
      || priority !== 'control' && (this.#applicationFrames >= this.options.maxQueuedFrames - this.options.reservedControlFrames
        || size > this.options.maxQueuedBytes - this.options.reservedControlBytes - this.#applicationBytes)
      || priority === 'data' && (this.#dataFrames >= this.options.maxQueuedFrames - this.options.reservedControlFrames - (this.options.reservedUrgentFrames ?? 0)
        || size > this.options.maxQueuedBytes - this.options.reservedControlBytes - (this.options.reservedUrgentBytes ?? 0) - this.#dataBytes)) {
      throw new NodeWorkerTransportError('NODE_WORKER_CAPACITY');
    }
    const cancel = () => this.#cancel(frame);
    const frame: PendingFrame = { bytes: encodeNodeWorkerFrame(text, this.options.maxFrameBytes), priority, result: Promise.withResolvers<void>(),
      authority, submitted: false, detach: () => authority.signal.removeEventListener('abort', cancel) };
    this.#bytes += size;
    this.#frames += 1;
    if (priority !== 'control') { this.#applicationBytes += size; this.#applicationFrames += 1; }
    if (priority === 'data') { this.#dataBytes += size; this.#dataFrames += 1; }
    this.#queue(priority).push(frame);
    authority.signal.addEventListener('abort', cancel, { once: true });
    if (!this.#current) void this.#write();
    return Object.freeze({ get submitted() { return frame.submitted; }, drained: frame.result.promise });
  }

  close(): void { this.#fail(new NodeWorkerTransportError('NODE_WORKER_CLOSED')); }

  /** Waits for a reservation release; callers own bounded admission retries and their deadline. */
  waitForRelease(signal: AbortSignal): Promise<void> {
    if (this.#failure) return Promise.reject(this.#failure);
    if (signal.aborted) return Promise.reject(signal.reason);
    if (!this.#frames) return Promise.resolve();
    if (this.#waiting.size >= this.options.maxQueuedFrames) return Promise.reject(new NodeWorkerTransportError('NODE_WORKER_CAPACITY'));
    return new Promise<void>((resolve, reject) => {
      const settle = (error?: unknown) => {
        this.#waiting.delete(settle); signal.removeEventListener('abort', cancel);
        if (error === undefined) resolve(); else reject(error);
      };
      const cancel = () => settle(signal.reason);
      this.#waiting.add(settle);
      signal.addEventListener('abort', cancel, { once: true });
    });
  }

  get bufferedBytes(): number { return this.#bytes; }

  async #write(): Promise<void> {
    while (!this.#failure) {
      const frame = this.#control.shift() ?? this.#urgent.shift() ?? this.#data.shift();
      if (!frame) return;
      this.#current = frame;
      try {
        frame.authority.signal.throwIfAborted();
        frame.authority.validate();
        frame.authority.signal.throwIfAborted();
        if (this.#failure) throw this.#failure;
        this.#timer = (this.options.scheduleTimeout ?? scheduleTimeout)(() => {
          this.#fail(new NodeWorkerTransportError('NODE_WORKER_TIMEOUT'));
        }, this.options.writeTimeoutMs);
        if (this.#failure) throw this.#failure;
        frame.submitted = true;
        await this.port.write(frame.bytes);
        if (!this.#failure) frame.result.resolve();
      } catch (error) {
        if (frame.submitted) this.#fail(new NodeWorkerTransportError('NODE_WORKER_CLOSED'));
        else frame.result.reject(error);
      }
      finally {
        this.#timer?.cancel();
        this.#timer = null;
        this.#current = null;
        this.#release(frame);
      }
    }
  }

  #cancel(frame: PendingFrame): void {
    frame.result.reject(frame.authority.signal.reason);
    if (frame === this.#current) return;
    const queue = this.#queue(frame.priority);
    const index = queue.indexOf(frame);
    if (index < 0) return;
    queue.splice(index, 1);
    this.#release(frame);
  }

  #fail(error: NodeWorkerTransportError): void {
    if (this.#failure) return;
    this.#failure = error;
    for (const settle of this.#waiting) settle(error);
    this.#detach();
    this.#timer?.cancel();
    this.#timer = null;
    this.#current?.result.reject(error);
    for (const frame of [...this.#control.splice(0), ...this.#urgent.splice(0), ...this.#data.splice(0)]) {
      frame.result.reject(error);
      this.#release(frame);
    }
    try { this.port.close(); } catch { /* The owner still requires OS cleanup proof. */ }
    try { this.options.failed(error); } catch { /* Observer failure cannot reopen the pipe. */ }
  }

  #release(frame: PendingFrame): void {
    frame.detach();
    const size = frame.bytes.byteLength;
    this.#bytes -= size;
    this.#frames -= 1;
    if (frame.priority !== 'control') { this.#applicationBytes -= size; this.#applicationFrames -= 1; }
    if (frame.priority === 'data') { this.#dataBytes -= size; this.#dataFrames -= 1; }
    frame.bytes.fill(0);
    for (const settle of this.#waiting) settle();
  }

  #queue(priority: NodeWorkerFramePriority): PendingFrame[] {
    return priority === 'control' ? this.#control : priority === 'urgent' ? this.#urgent : this.#data;
  }
}

function scheduleTimeout(callback: () => void, delayMs: number): { cancel(): void } {
  const timer = setTimeout(callback, delayMs);
  timer.unref();
  return { cancel: () => clearTimeout(timer) };
}
