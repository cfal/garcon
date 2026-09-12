import type { NodeReplyAuthority, NodeReplyPort } from './reply-port.js';
import type { NodeSocketWriter } from './socket-writer.js';

export const NODE_SOCKET_REPLY_LIMITS = Object.freeze({ maxEntries: 56, maxBytes: 2 * 1024 * 1024, maxAgeMs: 10_000 });

export interface NodeSocketReplyOutboxOptions {
  readonly signal: AbortSignal;
  readonly maxEntries?: number;
  readonly maxBytes?: number;
  readonly maxAgeMs?: number;
  readonly now?: () => number;
  readonly scheduleTimeout?: (callback: () => void, delayMs: number) => { cancel(): void };
  validate(): void;
  failed(error: unknown): void;
}

interface ReplyEntry {
  readonly channel: symbol;
  readonly requestId: number;
  readonly bytes: number;
  readonly expiresAt: number;
  readonly authority: NodeReplyAuthority;
  readonly cancellation: AbortController;
  readonly signal: AbortSignal;
  readonly detach: () => void;
  timer: { cancel(): void } | null;
  text: string;
}

export class NodeSocketReplyError extends Error {
  constructor(readonly code: 'NODE_REPLY_CAPACITY' | 'NODE_REPLY_EXPIRED' | 'NODE_REPLY_CLOSED' | 'NODE_REPLY_PROTOCOL') {
    super('Node reply delivery is unavailable');
    this.name = 'NodeSocketReplyError';
  }
}

/** Shares bounded serialized reply ownership across every RPC channel on one physical socket. */
export class NodeSocketReplyOutbox {
  readonly #limits: { readonly maxEntries: number; readonly maxBytes: number; readonly maxAgeMs: number };
  readonly #entries: ReplyEntry[] = [];
  readonly #closing = new AbortController();
  readonly #detach: () => void;
  #active: ReplyEntry | null = null;
  #pumping = false;
  #bytes = 0;
  #lastTime = 0;

  constructor(private readonly writer: Pick<NodeSocketWriter, 'sendApplication' | 'sendApplicationWhenWritable' | 'close'>,
    private readonly options: NodeSocketReplyOutboxOptions) {
    this.options = Object.freeze({ ...options });
    this.#limits = Object.freeze({ maxEntries: options.maxEntries ?? NODE_SOCKET_REPLY_LIMITS.maxEntries,
      maxBytes: options.maxBytes ?? NODE_SOCKET_REPLY_LIMITS.maxBytes, maxAgeMs: options.maxAgeMs ?? NODE_SOCKET_REPLY_LIMITS.maxAgeMs });
    if (!Object.values(this.#limits).every((value) => Number.isSafeInteger(value) && value > 0)) throw new TypeError('Invalid node reply limits');
    const close = () => this.close();
    this.#detach = () => options.signal.removeEventListener('abort', close);
    options.signal.addEventListener('abort', close, { once: true });
    if (options.signal.aborted) this.close();
  }

  get pendingEntries(): number { return this.#entries.length; }
  get pendingBytes(): number { return this.#bytes; }

  channel(encode: (serialized: string) => string = (text) => text): NodeReplyPort {
    const channel = Symbol();
    return {
      enqueue: (requestId, serialized, authority) => {
        try {
          this.#validate(); authority.signal.throwIfAborted(); authority.validate(); authority.signal.throwIfAborted();
          this.#enqueue(channel, requestId, encode(serialized), authority);
        } catch (error) {
          if (!authority.signal.aborted) this.#fail(error);
          throw error;
        }
      },
      cancel: (requestId) => {
        const entry = this.#entries.find((entry) => entry.channel === channel && entry.requestId === requestId);
        entry?.cancellation.abort(new DOMException('Node reply cancelled', 'AbortError'));
      },
      close: () => this.close(),
    };
  }

  close(): void { this.#fail(new NodeSocketReplyError('NODE_REPLY_CLOSED')); }

  #enqueue(channel: symbol, requestId: number, text: string, authority: NodeReplyAuthority): void {
    this.#validate(); authority.signal.throwIfAborted();
    if (!Number.isSafeInteger(requestId) || requestId < 1
      || this.#entries.some((entry) => entry.channel === channel && entry.requestId === requestId)) throw new NodeSocketReplyError('NODE_REPLY_PROTOCOL');
    const now = this.#now();
    if (this.#entries.some((entry) => !entry.signal.aborted && now >= entry.expiresAt)) throw new NodeSocketReplyError('NODE_REPLY_EXPIRED');
    const bytes = Buffer.byteLength(text);
    if (this.#entries.length >= this.#limits.maxEntries || bytes > this.#limits.maxBytes - this.#bytes) throw new NodeSocketReplyError('NODE_REPLY_CAPACITY');
    const cancellation = new AbortController();
    const signal = AbortSignal.any([this.#closing.signal, authority.signal, cancellation.signal]);
    const cancel = () => { if (this.#active !== entry) this.#release(entry); };
    const entry: ReplyEntry = { channel, requestId, text, bytes, expiresAt: now + this.#limits.maxAgeMs,
      authority, cancellation, signal, timer: null, detach: () => signal.removeEventListener('abort', cancel) };
    this.#entries.push(entry); this.#bytes += bytes;
    signal.addEventListener('abort', cancel, { once: true });
    entry.timer = (this.options.scheduleTimeout ?? scheduleTimeout)(() => {
      if (this.#entries.includes(entry) && !signal.aborted) this.#fail(new NodeSocketReplyError('NODE_REPLY_EXPIRED'));
    }, this.#limits.maxAgeMs);
    if (!this.#entries.includes(entry)) { entry.timer.cancel(); entry.timer = null; return; }
    if (signal.aborted) { this.#release(entry); return; }
    if (!this.#pumping) { this.#pumping = true; void this.#pump(); }
  }

  async #pump(): Promise<void> {
    try {
      while (!this.#closing.signal.aborted && this.#entries.length) {
        const entry = this.#entries[0]!;
        this.#active = entry;
        const validate = () => {
          this.#validate(); entry.signal.throwIfAborted(); entry.authority.validate(); entry.signal.throwIfAborted();
          if (this.#now() >= entry.expiresAt) throw new NodeSocketReplyError('NODE_REPLY_EXPIRED');
        };
        try {
          validate();
          if (!this.writer.sendApplication(entry.text)) await this.writer.sendApplicationWhenWritable(entry.text, entry.signal, validate);
        } catch (error) { if (!entry.signal.aborted) this.#fail(error); }
        finally { this.#release(entry); this.#active = null; }
      }
    } finally { this.#pumping = false; }
  }

  #release(entry: ReplyEntry): void {
    const index = this.#entries.indexOf(entry);
    if (index < 0) return;
    this.#entries.splice(index, 1); this.#bytes -= entry.bytes;
    entry.text = ''; entry.detach(); entry.timer?.cancel(); entry.timer = null;
  }

  #validate(): void {
    this.#closing.signal.throwIfAborted(); this.options.signal.throwIfAborted(); this.options.validate();
    this.#closing.signal.throwIfAborted(); this.options.signal.throwIfAborted();
  }

  #now(): number {
    const now = (this.options.now ?? (() => performance.now()))();
    if (!Number.isFinite(now) || now < this.#lastTime) throw new NodeSocketReplyError('NODE_REPLY_EXPIRED');
    this.#lastTime = now;
    return now;
  }

  #fail(error: unknown): void {
    if (this.#closing.signal.aborted) return;
    this.#detach(); this.#closing.abort(error);
    for (const entry of [...this.#entries]) if (entry !== this.#active) this.#release(entry);
    this.writer.close();
    try { this.options.failed(error); } catch { /* A failed physical hop cannot regain reply authority. */ }
  }
}

function scheduleTimeout(callback: () => void, delayMs: number): { cancel(): void } {
  const timer = setTimeout(callback, delayMs); timer.unref();
  return { cancel: () => clearTimeout(timer) };
}
