import type { NodeSocketWriter } from '../execution-nodes/transport/socket-writer.js';
import { NodeWorkerTransportError } from './worker/framing.js';

export const NODE_SESSION_OUTPUT_ADMISSION_MS = 2000;
export const NODE_SESSION_OUTPUT_RELAY_LIMITS = Object.freeze({ maxEntries: 256, maxBytes: 4 * 1024 * 1024 });

interface OutputEntry {
  readonly admission: 'data' | 'application';
  readonly admittedAt: number;
  readonly bytes: number;
  text: string;
}

interface NodeSessionOutputRelayOptions {
  readonly signal: AbortSignal;
  readonly now?: () => number;
  readonly maxEntries?: number;
  readonly maxBytes?: number;
  readonly scheduleTimeout?: (callback: () => void, delayMs: number) => { cancel(): void };
  validate(): void;
  failed(error: unknown): void;
}

type OutputWriter = Pick<NodeSocketWriter, 'sendData' | 'sendApplication' | 'sendWhenWritable' | 'sendApplicationWhenWritable' | 'close'>;

/** Owns output waiting for socket admission so worker replies remain readable. */
export class NodeSessionOutputRelay {
  readonly #entries: OutputEntry[] = [];
  readonly #closing = new AbortController();
  readonly #detach: () => void;
  readonly #limits: { readonly maxEntries: number; readonly maxBytes: number };
  #active: OutputEntry | null = null;
  #timer: { cancel(): void } | null = null;
  #bytes = 0;
  #lastTime = 0;
  #lastProgressAt = 0;

  constructor(private readonly writer: OutputWriter, private readonly options: NodeSessionOutputRelayOptions) {
    this.#limits = { maxEntries: options.maxEntries ?? NODE_SESSION_OUTPUT_RELAY_LIMITS.maxEntries,
      maxBytes: options.maxBytes ?? NODE_SESSION_OUTPUT_RELAY_LIMITS.maxBytes };
    if (!Object.values(this.#limits).every((value) => Number.isSafeInteger(value) && value > 0)) throw new TypeError('Invalid output relay limits');
    const close = () => this.#fail(new NodeWorkerTransportError('NODE_WORKER_CLOSED'));
    this.#detach = () => options.signal.removeEventListener('abort', close);
    options.signal.addEventListener('abort', close, { once: true });
    if (options.signal.aborted) close();
  }

  get pendingEntries(): number { return this.#entries.length; }
  get pendingBytes(): number { return this.#bytes; }

  enqueue(text: string, admission: OutputEntry['admission']): void {
    if (this.#closing.signal.aborted) return;
    try {
      this.#validate();
      const now = this.#now();
      if (this.#entries.length) this.#remaining(this.#entries[0]!, now);
      // Reserves the retained string and its full framed UTF-8 representation.
      const bytes = 2 * text.length + Buffer.byteLength(text) + 14;
      if (this.#entries.length >= this.#limits.maxEntries || bytes > this.#limits.maxBytes - this.#bytes) {
        throw new NodeWorkerTransportError('NODE_WORKER_CAPACITY');
      }
      this.#entries.push({ text, admission, bytes, admittedAt: now });
      this.#bytes += bytes;
      if (!this.#active) void this.#pump();
    } catch (error) { this.#fail(error); }
  }

  async #pump(): Promise<void> {
    while (!this.#closing.signal.aborted && this.#entries.length) {
      const entry = this.#active = this.#entries[0]!;
      const validate = () => { this.#validate(); this.#remaining(entry, this.#now()); };
      try {
        validate();
        const accepted = entry.admission === 'data' ? this.writer.sendData(entry.text) : this.writer.sendApplication(entry.text);
        if (!accepted) {
          this.#timer = (this.options.scheduleTimeout ?? scheduleTimeout)(() => {
            if (this.#active === entry) this.#fail(new NodeWorkerTransportError('NODE_WORKER_TIMEOUT'));
          }, this.#remaining(entry, this.#now()));
          if (entry.admission === 'data') await this.writer.sendWhenWritable(entry.text, this.#closing.signal, validate);
          else await this.writer.sendApplicationWhenWritable(entry.text, this.#closing.signal, validate);
        }
        validate();
        this.#lastProgressAt = this.#now();
      } catch (error) { this.#fail(error); }
      finally {
        this.#timer?.cancel(); this.#timer = null;
        this.#entries.shift();
        this.#bytes -= entry.bytes;
        entry.text = '';
        this.#active = null;
      }
    }
  }

  #remaining(entry: OutputEntry, now: number): number {
    const remaining = Math.max(entry.admittedAt, this.#lastProgressAt) + NODE_SESSION_OUTPUT_ADMISSION_MS - now;
    if (remaining <= 0) throw new NodeWorkerTransportError('NODE_WORKER_TIMEOUT');
    return remaining;
  }

  #validate(): void {
    this.#closing.signal.throwIfAborted(); this.options.signal.throwIfAborted(); this.options.validate();
    this.#closing.signal.throwIfAborted(); this.options.signal.throwIfAborted();
  }

  #now(): number {
    const now = (this.options.now ?? (() => performance.now()))();
    if (!Number.isFinite(now) || now < this.#lastTime) throw new NodeWorkerTransportError('NODE_WORKER_TIMEOUT');
    this.#lastTime = now;
    return now;
  }

  #fail(error: unknown): void {
    if (this.#closing.signal.aborted) return;
    this.#detach(); this.#closing.abort(error);
    this.#timer?.cancel(); this.#timer = null;
    for (const entry of this.#entries.splice(this.#active ? 1 : 0)) {
      this.#bytes -= entry.bytes;
      entry.text = '';
    }
    try { this.options.failed(error); }
    catch { /* The captured physical connection still closes when notification fails. */ }
    finally { this.writer.close(); }
  }
}

function scheduleTimeout(callback: () => void, delayMs: number): { cancel(): void } {
  const timer = setTimeout(callback, delayMs); timer.unref();
  return { cancel: () => clearTimeout(timer) };
}
