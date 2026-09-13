import { MAX_NODE_OUTPUT_SEQUENCE, parseNodeOutputAck, parseProducerStreamIdentity, producerStreamKey, type NodeOutputAck, type NodeReplayReply, type ProducerStreamIdentity } from '@garcon/server-agent-interface';
import { isExecutionIdentity } from '../../../common/execution-location.js';
import { parseNodeSessionIdentity, sameNodeSession, type NodeSessionIdentity } from '../../../common/node-operation.js';
import { NodeReplayCache, NodeReplayGapError, NodeReplayUnavailableError, type NodeReplayOptions } from '../replay-cache.js';
import { NodeWorkerTransportError } from './framing.js';
import { NODE_WORKER_OUTPUT_QUEUE, type NodeWorkerOutputQueueLimits } from './output-limits.js';

export interface NodeOutputDeliveryAttempt {
  readonly generation: number;
  readonly signal: AbortSignal;
}

export interface NodeOutputDeliveryRecord {
  readonly instanceId: string;
  readonly stream: ProducerStreamIdentity;
  readonly sequence: number;
  readonly serialized: string;
  readonly signal: AbortSignal;
}

export interface NodeOutputReplayCursor {
  readonly stream: ProducerStreamIdentity;
  readonly afterSequence: number;
}

/** Releases record staging when the captured stream or attempt aborts; no sender owns replay history. */
export type NodeOutputRecordSender = (record: NodeOutputDeliveryRecord, attempt: NodeOutputDeliveryAttempt, progress: () => void) => Promise<void>;

interface StreamDelivery {
  readonly instanceId: string;
  readonly stream: ProducerStreamIdentity;
  readonly failed: (error: unknown) => void;
  readonly cancellation: AbortController;
  readonly detach: () => void;
  produced: number;
  acknowledged: number;
  retired: boolean;
  admitting: boolean;
}

interface DeliveryAttempt {
  readonly token: NodeOutputDeliveryAttempt;
  readonly cancellation: AbortController;
  readonly sender: NodeOutputRecordSender;
  readonly replayed: Map<StreamDelivery, number>;
  live: boolean;
  busy: boolean;
  lastProgressAt: number;
}

interface LiveRecord {
  readonly owner: StreamDelivery;
  readonly record: NodeOutputDeliveryRecord;
  readonly bytes: number;
  readonly admittedAt: number;
}

export interface NodeWorkerOutputDeliveryOptions {
  readonly session: NodeSessionIdentity;
  readonly instanceIds: ReadonlySet<string>;
  readonly signal: AbortSignal;
  readonly replay: NodeReplayOptions;
  readonly limits?: Partial<NodeWorkerOutputQueueLimits>;
  readonly now: () => number;
  readonly scheduleTimeout?: (callback: () => void, delayMs: number) => { cancel(): void };
  validate(): void;
  disconnected(error: unknown, attempt: NodeOutputDeliveryAttempt): void;
  failed(error: unknown): void;
}

/** Owns the session's sole replay cache and discards physical live transit on attempt loss. */
export class NodeWorkerOutputDelivery {
  readonly #session: NodeSessionIdentity;
  readonly #cache: NodeReplayCache;
  readonly #limits: NodeWorkerOutputQueueLimits;
  readonly #streams = new Map<string, StreamDelivery>();
  readonly #retired = new Map<string, { readonly stream: ProducerStreamIdentity; readonly produced: number }>();
  readonly #instances: ReadonlySet<string>;
  readonly #live = new Set<LiveRecord>();
  readonly #detach: () => void;
  #attempt: DeliveryAttempt | null = null;
  #timer: { cancel(): void } | null = null;
  #bytes = 0;
  #lastTime = 0;
  #closed = false;
  #generation = 0;

  constructor(private readonly options: NodeWorkerOutputDeliveryOptions) {
    const session = parseNodeSessionIdentity(options.session);
    const limits = { ...NODE_WORKER_OUTPUT_QUEUE, ...options.limits };
    if (!session || !options.instanceIds.size || options.instanceIds.size > 64 || [...options.instanceIds].some((id) => !isExecutionIdentity(id))
      || Object.values(limits).some((value) => !Number.isSafeInteger(value) || value < 1)) throw new TypeError('Invalid output delivery');
    this.#session = Object.freeze(session);
    this.#instances = new Set(options.instanceIds);
    this.#limits = Object.freeze(limits);
    this.options = Object.freeze({ ...options });
    // Validation may retire operations reentrantly; cache mutations use only its captured monotonic time.
    this.#cache = new NodeReplayCache(options.replay, () => this.#lastTime);
    const close = () => this.close();
    this.#detach = () => options.signal.removeEventListener('abort', close);
    options.signal.addEventListener('abort', close, { once: true });
    if (options.signal.aborted) this.close();
  }

  install(instanceId: string, value: ProducerStreamIdentity, signal: AbortSignal, failed: (error: unknown) => void): void {
    this.#validate(); signal.throwIfAborted();
    const stream = parseProducerStreamIdentity(value);
    if (!this.#instances.has(instanceId) || !stream || !sameNodeSession(stream, this.#session)) throw protocol();
    const key = producerStreamKey(stream);
    this.#cache.register(stream);
    const retire = () => this.retire(stream);
    this.#streams.set(key, { instanceId, stream: Object.freeze(stream), failed, produced: 0, acknowledged: 0, retired: false, admitting: false, cancellation: new AbortController(),
      detach: () => signal.removeEventListener('abort', retire) });
    signal.addEventListener('abort', retire, { once: true });
  }

  accept(stream: ProducerStreamIdentity, serialized: string, sequence: number): void {
    this.prune();
    const owner = this.#require(stream);
    if (owner.admitting) {
      const error = protocol(); this.#failStream(owner, error); throw error;
    }
    owner.admitting = true;
    let pending: LiveRecord | null = null;
    const attempt = this.#attempt;
    try {
      if (attempt?.live) {
        const bytes = Buffer.byteLength(serialized);
        if (this.#live.size >= this.#limits.maxRecords || bytes > this.#limits.maxBytes - this.#bytes) {
          throw new NodeWorkerTransportError('NODE_WORKER_CAPACITY');
        }
        pending = { owner, record: Object.freeze({ instanceId: owner.instanceId, stream: owner.stream, sequence, serialized, signal: owner.cancellation.signal }),
          bytes, admittedAt: this.#lastTime };
        this.#live.add(pending); this.#bytes += bytes;
      }
      this.#cache.append(owner.stream, sequence, serialized);
      this.#validate();
      if (owner.retired) throw new NodeReplayUnavailableError();
      owner.produced = sequence;
    } catch (error) {
      if (pending) this.#discard(pending);
      this.#validate();
      this.#failStream(owner, error); throw error;
    } finally { owner.admitting = false; }
    this.#schedule();
    if (attempt?.live && attempt === this.#attempt && !attempt.busy) {
      attempt.busy = true;
      queueMicrotask(() => { void this.#pump(attempt); });
    }
  }

  beginRecovery(sender: NodeOutputRecordSender): NodeOutputDeliveryAttempt {
    this.#validate();
    const generation = ++this.#generation;
    if (!Number.isSafeInteger(generation)) { const error = protocol(); this.#fail(error); throw error; }
    if (this.#attempt) this.suspend(this.#attempt.token);
    this.#validate();
    if (this.#generation !== generation || this.#attempt) throw protocol();
    const cancellation = new AbortController();
    const token = Object.freeze({ generation, signal: cancellation.signal });
    this.#attempt = { token, cancellation, sender, live: false, busy: false, lastProgressAt: this.#lastTime, replayed: new Map() };
    return token;
  }

  async replay(token: NodeOutputDeliveryAttempt, cursors: readonly NodeOutputReplayCursor[]): Promise<readonly NodeReplayReply[] | null> {
    this.#validate();
    const attempt = this.#current(token);
    if (!attempt) return null;
    if (attempt.live || attempt.busy) throw protocol();
    attempt.busy = true;
    const seen = new Set<string>();
    const results: NodeReplayReply[] = [];
    try {
      const ranges = cursors.map((cursor) => {
        const stream = parseProducerStreamIdentity(cursor.stream);
        if (!stream || !sameNodeSession(stream, this.#session) || !Number.isSafeInteger(cursor.afterSequence)
          || cursor.afterSequence < 0 || cursor.afterSequence > MAX_NODE_OUTPUT_SEQUENCE) throw protocol();
        const key = producerStreamKey(stream);
        const owner = this.#streams.get(key);
        const retired = this.#retired.get(key);
        if (seen.has(key) || owner?.admitting || !owner && !retired || cursor.afterSequence > (owner ?? retired)!.produced) throw protocol();
        seen.add(key);
        if (!owner) return { owner: null, range: cursor.afterSequence === retired!.produced
          ? { type: 'node-replay-ready', stream: retired!.stream, afterSequence: cursor.afterSequence, throughSequence: retired!.produced } as const
          : { type: 'node-replay-gap', stream: retired!.stream, requestedAfter: cursor.afterSequence,
            firstRetainedSequence: retired!.produced + 1, lastProducedSequence: retired!.produced } as const };
        const range = this.#cache.capture(owner.stream, Math.max(cursor.afterSequence, owner.acknowledged));
        return { owner, range: range.type === 'node-replay-ready' ? { ...range, afterSequence: cursor.afterSequence } : range };
      });
      for (const { owner, range } of ranges) {
        if (!this.#current(token)) return null;
        if (!owner) { results.push(range); continue; }
        if (owner.retired) continue;
        if (range.type === 'node-replay-gap') {
          results.push(range); this.#failStream(owner, new NodeReplayGapError()); continue;
        }
        let complete = true;
        for (let sequence = range.afterSequence + 1; sequence <= range.throughSequence; sequence += 1) {
          this.#validate();
          if (!this.#current(token)) return null;
          if (owner.retired) { complete = false; break; }
          if (sequence <= owner.acknowledged) { sequence = owner.acknowledged; continue; }
          const read = this.#cache.read(owner.stream, sequence, range.throughSequence);
          if ('type' in read) {
            results.push(read); this.#failStream(owner, new NodeReplayGapError()); complete = false; break;
          }
          try { await attempt.sender({ instanceId: owner.instanceId, stream: owner.stream, sequence, serialized: read.serialized, signal: owner.cancellation.signal }, token, () => {}); }
          catch (error) {
            if (owner.retired) { complete = false; break; }
            this.#disconnect(attempt, error); return null;
          }
          this.#validate();
          if (!this.#current(token)) return null;
        }
        if (complete && !owner.retired) { attempt.replayed.set(owner, range.throughSequence); results.push(range); }
      }
      return Object.freeze(results);
    } finally { attempt.busy = false; }
  }

  /** Requires every still-open stream to catch up before accepting the first physical live suffix. */
  resumeLive(token: NodeOutputDeliveryAttempt): boolean {
    this.#validate();
    const attempt = this.#current(token);
    if (!attempt || attempt.busy) return false;
    if (attempt.live) return true;
    for (const owner of this.#streams.values()) {
      if (!owner.retired && (owner.admitting || (attempt.replayed.get(owner) ?? 0) !== owner.produced)) return false;
    }
    attempt.live = true;
    return true;
  }

  suspend(token: NodeOutputDeliveryAttempt): boolean {
    const attempt = this.#current(token);
    if (!attempt) return false;
    this.#attempt = null;
    this.#live.clear(); this.#bytes = 0;
    this.#timer?.cancel(); this.#timer = null;
    attempt.cancellation.abort(new NodeWorkerTransportError('NODE_WORKER_CLOSED'));
    return true;
  }

  acknowledge(token: NodeOutputDeliveryAttempt, ack: NodeOutputAck): boolean {
    this.#validate();
    if (!this.#current(token)) return false;
    if (!parseNodeOutputAck(ack) || !sameNodeSession(ack.stream, this.#session)) throw protocol();
    const key = producerStreamKey(ack.stream);
    const owner = this.#streams.get(key);
    const produced = (owner ?? this.#retired.get(key))?.produced;
    if (produced === undefined || ack.throughSequence > produced) throw protocol();
    if (!owner) return false;
    this.#cache.acknowledge(ack.stream, ack.throughSequence);
    owner.acknowledged = Math.max(owner.acknowledged, ack.throughSequence);
    return true;
  }

  retire(stream: ProducerStreamIdentity): void {
    const owner = this.#streams.get(producerStreamKey(stream));
    if (!owner || owner.retired) return;
    owner.retired = true; owner.detach();
    this.#streams.delete(producerStreamKey(owner.stream));
    this.#retired.set(producerStreamKey(owner.stream), { stream: owner.stream, produced: owner.produced });
    this.#attempt?.replayed.delete(owner);
    owner.cancellation.abort(new NodeReplayUnavailableError());
    for (const record of this.#live) if (record.owner === owner) this.#discard(record);
    this.#cache.retire(owner.stream);
    this.#schedule();
  }

  prune(): void {
    this.#validate();
    this.#cache.prune();
    for (const record of this.#live) {
      if (this.#deadline(record) > this.#lastTime) break;
      this.#failStream(record.owner, new NodeWorkerTransportError('NODE_WORKER_TIMEOUT'));
    }
    this.#schedule();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true; this.#detach();
    if (this.#attempt) this.suspend(this.#attempt.token);
    for (const owner of this.#streams.values()) { owner.retired = true; owner.detach(); owner.cancellation.abort(new NodeReplayUnavailableError()); }
    this.#streams.clear(); this.#retired.clear(); this.#cache.clear();
  }

  get bufferedBytes(): number { return this.#bytes; }
  get bufferedRecords(): number { return this.#live.size; }
  get retainedBytes(): number { if (this.#closed) return 0; this.#validate(); return this.#cache.retainedBytes; }

  async #pump(attempt: DeliveryAttempt): Promise<void> {
    try {
      while (this.#current(attempt.token) && attempt.live && this.#live.size) {
        this.prune();
        const record = this.#live.values().next().value;
        if (!record) break;
        try { await attempt.sender(record.record, attempt.token, () => this.#progress(attempt, record)); }
        catch (error) {
          if (record.owner.retired) continue;
          this.#disconnect(attempt, error); return;
        }
        if (!this.#current(attempt.token)) return;
        this.#progress(attempt, record);
        this.#discard(record);
      }
    } catch (error) { this.#fail(error); }
    finally { attempt.busy = false; this.#schedule(); }
  }

  #require(stream: ProducerStreamIdentity): StreamDelivery {
    const owner = this.#streams.get(producerStreamKey(stream));
    if (!owner || owner.retired) throw new NodeReplayUnavailableError();
    return owner;
  }

  #current(token: NodeOutputDeliveryAttempt): DeliveryAttempt | null {
    return this.#attempt?.token === token ? this.#attempt : null;
  }

  #failStream(owner: StreamDelivery, error: unknown): void {
    if (owner.retired) return;
    this.retire(owner.stream);
    try { owner.failed(error); } catch { /* Stream authority is retired before callbacks run. */ }
  }

  #disconnect(attempt: DeliveryAttempt, error: unknown): void {
    if (!this.suspend(attempt.token)) return;
    try { this.options.disconnected(error, attempt.token); } catch { /* The failed attempt cannot invalidate a replacement. */ }
  }

  #fail(error: unknown): void {
    if (this.#closed) return;
    this.close();
    try { this.options.failed(error); } catch { /* The owner must retire the failed logical session. */ }
  }

  #discard(record: LiveRecord): void { if (this.#live.delete(record)) this.#bytes -= record.bytes; }

  #progress(attempt: DeliveryAttempt, record: LiveRecord): void {
    if (!this.#current(attempt.token) || !this.#live.has(record)) return;
    this.prune();
    if (!this.#current(attempt.token) || !this.#live.has(record)) return;
    attempt.lastProgressAt = this.#lastTime;
    this.#schedule();
  }

  #deadline(record: LiveRecord): number {
    return Math.max(record.admittedAt, this.#attempt?.lastProgressAt ?? record.admittedAt) + this.#limits.retentionMs;
  }

  #validate(): void {
    if (this.#closed) throw protocol();
    try {
      this.options.signal.throwIfAborted(); this.options.validate(); this.options.signal.throwIfAborted();
      const now = this.options.now();
      if (!Number.isFinite(now) || now < this.#lastTime || now < 0 || this.#closed) throw protocol();
      this.#lastTime = now;
    } catch (error) { this.#fail(error); throw error; }
  }

  #schedule(): void {
    this.#timer?.cancel(); this.#timer = null;
    const first = this.#live.values().next().value;
    if (this.#closed || !first) return;
    this.#timer = (this.options.scheduleTimeout ?? scheduleTimeout)(() => {
      this.#timer = null;
      try { this.prune(); } catch (error) { this.#fail(error); }
    }, Math.max(0, this.#deadline(first) - this.#lastTime));
  }
}

function protocol(): NodeWorkerTransportError { return new NodeWorkerTransportError('NODE_WORKER_PROTOCOL'); }
function scheduleTimeout(callback: () => void, delayMs: number): { cancel(): void } {
  const timer = setTimeout(callback, delayMs);
  timer.unref();
  return { cancel: () => clearTimeout(timer) };
}
