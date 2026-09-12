import { NODE_WIRE_VERSION, parseProducerStreamIdentity, producerStreamKey, type ProducerStreamIdentity } from '@garcon/server-agent-interface';
import { isExecutionIdentity } from '../../../common/execution-location.js';
import { parseNodeSessionIdentity, sameNodeSession, type NodeSessionIdentity } from '../../../common/node-operation.js';
import { NodeOutputEncoder, type NodeOutputPermissionHandles } from '../output-encoder.js';
import { MAX_NODE_STREAM_IDENTITIES, NodeStreamIdentityExhaustedError } from '../replay-cache.js';
import { NodeWorkerTransportError } from './framing.js';
import { NODE_WORKER_OUTPUT_QUEUE } from './output-limits.js';
import { iterateNodeWorkerOutput } from './output-protocol.js';
import { parseNodeWorkerOutputRetirementText, serializeNodeWorkerOutputRetirement } from './output-retirement.js';
import type { NodeWorkerWriter } from './writer.js';

interface OutputOwner {
  readonly stream: ProducerStreamIdentity;
  readonly encoder: NodeOutputEncoder;
  readonly cancellation: AbortController;
  readonly detach: () => void;
  readonly failed: (error: unknown) => void;
  failureReported: boolean;
  peerRetired: boolean;
}

interface OutputRecord {
  readonly owner: OutputOwner;
  readonly sequence: number;
  readonly bytes: Buffer;
  readonly expiresAt: number;
}

export interface NodeWorkerOutputPortOptions {
  readonly session: NodeSessionIdentity;
  readonly instanceId: string;
  readonly signal: AbortSignal;
  readonly limits?: Partial<typeof NODE_WORKER_OUTPUT_QUEUE>;
  readonly now: () => number;
  readonly scheduleTimeout?: (callback: () => void, delayMs: number) => { cancel(): void };
  validate(): void;
  failed(error: unknown): void;
}

/** Admits original records synchronously and shares one drain-paced FIFO across an instance's streams. */
export class NodeWorkerOutputPort {
  readonly #session: NodeSessionIdentity;
  readonly #limits: typeof NODE_WORKER_OUTPUT_QUEUE;
  readonly #streams = new Map<string, OutputOwner | null>();
  readonly #queue: OutputRecord[] = [];
  readonly #retirements = new Set<ProducerStreamIdentity>();
  readonly #detach: () => void;
  #current: OutputRecord | null = null;
  #timer: { cancel(): void } | null = null;
  #pumping = false;
  #closed = false;
  #bytes = 0;
  #lastTime = 0;

  constructor(private readonly writer: Pick<NodeWorkerWriter, 'submit'>, private readonly options: NodeWorkerOutputPortOptions) {
    const session = parseNodeSessionIdentity(options.session);
    const limits = { ...NODE_WORKER_OUTPUT_QUEUE, ...options.limits };
    if (!session || !isExecutionIdentity(options.instanceId)
      || Object.values(limits).some((value) => !Number.isSafeInteger(value) || value < 1)) throw new TypeError('Invalid worker output queue');
    this.#session = Object.freeze(session);
    this.#limits = Object.freeze(limits);
    this.options = Object.freeze({ ...options });
    const close = () => this.close();
    this.#detach = () => options.signal.removeEventListener('abort', close);
    options.signal.addEventListener('abort', close, { once: true });
    if (options.signal.aborted) this.close();
  }

  install(value: ProducerStreamIdentity, signal: AbortSignal, permissionHandles: NodeOutputPermissionHandles,
    failed: (error: unknown) => void): NodeOutputEncoder {
    this.#validate();
    const stream = parseProducerStreamIdentity(value);
    if (!stream || !sameNodeSession(stream, this.#session)) throw new TypeError('Invalid output stream');
    const key = producerStreamKey(stream);
    if (this.#streams.has(key)) throw new TypeError('Worker output stream cannot be rebound');
    if (this.#streams.size >= MAX_NODE_STREAM_IDENTITIES) throw new NodeStreamIdentityExhaustedError();
    signal.throwIfAborted();
    const encoder = new NodeOutputEncoder({ identity: stream, permissionHandles,
      accept: (serialized, sequence) => this.#accept(owner, serialized, sequence),
      retire: () => this.#retire(owner), onOutputFailure: (error) => this.#notify(owner, error) });
    const retire = () => encoder.retire();
    const owner: OutputOwner = { stream: encoder.identity, encoder, cancellation: new AbortController(), failed, failureReported: false, peerRetired: false,
      detach: () => signal.removeEventListener('abort', retire) };
    this.#streams.set(key, owner);
    signal.addEventListener('abort', retire, { once: true });
    return encoder;
  }

  retire(stream: ProducerStreamIdentity): void { this.#streams.get(producerStreamKey(stream))?.encoder.retire(); }

  receiveRetirement(text: string): void {
    this.#validate();
    const frame = parseNodeWorkerOutputRetirementText(text);
    if (!frame || frame.instanceId !== this.options.instanceId || !sameNodeSession(frame.stream, this.#session)) {
      throw new NodeWorkerTransportError('NODE_WORKER_PROTOCOL');
    }
    const owner = this.#streams.get(producerStreamKey(frame.stream));
    if (!owner) return;
    owner.peerRetired = true;
    owner.encoder.retire();
  }

  prune(): void {
    const now = this.#validate();
    for (const record of [...this.#queue]) {
      if (record.expiresAt > now) break;
      if (!record.owner.cancellation.signal.aborted) this.#failOwner(record.owner, new NodeWorkerTransportError('NODE_WORKER_TIMEOUT'));
    }
    this.#schedule();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#detach();
    this.#retirements.clear();
    this.#timer?.cancel(); this.#timer = null;
    for (const owner of this.#streams.values()) owner?.encoder.retire();
    this.#streams.clear();
  }

  get bufferedBytes(): number { return this.#bytes; }
  get bufferedRecords(): number { return this.#queue.length; }

  #accept(owner: OutputOwner, serialized: string, sequence: number): void {
    this.prune();
    this.#validateOwner(owner);
    const size = Buffer.byteLength(serialized);
    if (this.#queue.length >= this.#limits.maxRecords || size > this.#limits.maxBytes - this.#bytes) {
      throw new NodeWorkerTransportError('NODE_WORKER_CAPACITY');
    }
    const record = { owner, sequence, bytes: Buffer.from(serialized), expiresAt: this.#lastTime + this.#limits.retentionMs };
    this.#queue.push(record); this.#bytes += size;
    this.#schedule();
    this.#wake();
  }

  async #pump(): Promise<void> {
    try {
      while (!this.#closed && (this.#queue.length || this.#retirements.size)) {
        if (this.#retirements.size) await this.#flushRetirements();
        if (this.#closed) break;
        const record = this.#queue[0];
        if (!record) continue;
        this.#current = record;
        try {
          for (const text of iterateNodeWorkerOutput(this.options.instanceId, record.owner.stream, record.sequence, record.bytes)) {
            this.prune(); this.#validateOwner(record.owner);
            if (this.#retirements.size) await this.#flushRetirements();
            this.#validateOwner(record.owner);
            if (this.#closed) break;
            await this.writer.submit(text, 'data', { signal: record.owner.cancellation.signal,
              validate: () => { this.prune(); this.#validateOwner(record.owner); } }, 'data').drained;
          }
        } catch (error) {
          if (!record.owner.cancellation.signal.aborted && !this.#closed) {
            if (error instanceof NodeWorkerTransportError && error.code === 'NODE_WORKER_CAPACITY') this.#failOwner(record.owner, error);
            else this.#failPipe(error);
          }
        } finally {
          this.#current = null;
          this.#discard(record);
        }
      }
    } finally { this.#pumping = false; this.#schedule(); }
  }

  #retire(owner: OutputOwner): void {
    const key = producerStreamKey(owner.stream);
    if (this.#streams.get(key) !== owner) return;
    this.#streams.set(key, null);
    owner.detach();
    if (!this.#closed && !owner.peerRetired) this.#retirements.add(owner.stream);
    owner.cancellation.abort(new NodeWorkerTransportError('NODE_WORKER_CLOSED'));
    for (const record of [...this.#queue]) if (record.owner === owner && record !== this.#current) this.#discard(record);
    if (this.#retirements.size) this.#wake();
    this.#schedule();
  }

  #wake(): void {
    if (this.#closed || this.#pumping) return;
    this.#pumping = true;
    queueMicrotask(() => { void this.#pump(); });
  }

  /** Paces identity-bounded retirement metadata ahead of sibling chunks without a burst of urgent frames. */
  async #flushRetirements(): Promise<void> {
    try {
      while (!this.#closed && this.#retirements.size) {
        const stream = this.#retirements.values().next().value!;
        this.#retirements.delete(stream);
        const text = serializeNodeWorkerOutputRetirement({ type: 'node-worker-output-retired', version: NODE_WIRE_VERSION,
          instanceId: this.options.instanceId, stream });
        await this.writer.submit(text, 'urgent', { signal: this.options.signal, validate: () => { this.#validate(); } }, 'application').drained;
      }
    } catch (error) { this.#failPipe(error); }
  }

  #failOwner(owner: OutputOwner, error: unknown): void { owner.encoder.retire(); this.#notify(owner, error); }

  #notify(owner: OutputOwner, error: unknown): void {
    if (owner.failureReported) return;
    owner.failureReported = true;
    try { owner.failed(error); } catch { /* The stream is already fenced before observers run. */ }
  }

  #failPipe(error: unknown): void {
    if (this.#closed) return;
    const owners = [...this.#streams.values()];
    this.close();
    for (const owner of owners) if (owner) this.#notify(owner, error);
    try { this.options.failed(error); } catch { /* A failed private pipe cannot regain output authority. */ }
  }

  #discard(record: OutputRecord): void {
    const index = this.#queue.indexOf(record);
    if (index < 0) return;
    this.#queue.splice(index, 1);
    this.#bytes -= record.bytes.byteLength;
    record.bytes.fill(0);
  }

  #validate(): number {
    if (this.#closed) throw new NodeWorkerTransportError('NODE_WORKER_CLOSED');
    try {
      this.options.signal.throwIfAborted(); this.options.validate(); this.options.signal.throwIfAborted();
      const now = this.options.now();
      if (!Number.isFinite(now) || now < this.#lastTime || now < 0) throw new NodeWorkerTransportError('NODE_WORKER_PROTOCOL');
      if (this.#closed) throw new NodeWorkerTransportError('NODE_WORKER_CLOSED');
      return this.#lastTime = now;
    } catch (error) { this.#failPipe(error); throw error; }
  }

  #validateOwner(owner: OutputOwner): void { owner.cancellation.signal.throwIfAborted(); }

  #schedule(): void {
    this.#timer?.cancel(); this.#timer = null;
    const first = this.#queue.find((record) => !record.owner.cancellation.signal.aborted);
    if (this.#closed || !first) return;
    this.#timer = (this.options.scheduleTimeout ?? scheduleTimeout)(() => {
      this.#timer = null;
      try { this.prune(); } catch (error) { this.#failPipe(error); }
    }, Math.max(0, first.expiresAt - this.#lastTime));
  }
}

function scheduleTimeout(callback: () => void, delayMs: number): { cancel(): void } {
  const timer = setTimeout(callback, delayMs);
  timer.unref();
  return { cancel: () => clearTimeout(timer) };
}
