import { MAX_NODE_OUTPUT_SEQUENCE, parseNodeOutputText, parseProducerStreamIdentity, producerStreamKey, type ProducerStreamIdentity } from '@garcon/server-agent-interface';
import { isExecutionIdentity } from '../../../common/execution-location.js';
import { parseNodeSessionIdentity, sameNodeSession, type NodeSessionIdentity } from '../../../common/node-operation.js';
import { NodeBulkError, NodeBulkTransfers, type NodeBulkLimits } from '../../execution-nodes/transport/bulk-transfers.js';
import type { NodeBulkIdentity } from '../../execution-nodes/transport/bulk-wire.js';
import { MAX_NODE_STREAM_IDENTITIES, NodeStreamIdentityExhaustedError } from '../replay-cache.js';
import { NodeWorkerTransportError } from './framing.js';
import { NodeOutputAssemblyBudget } from './output-budget.js';
import { NODE_WORKER_OUTPUT_ASSEMBLY } from './output-limits.js';
import { parseNodeWorkerOutputText, type NodeWorkerOutputChunk } from './output-protocol.js';
import { parseNodeWorkerOutputRetirementText } from './output-retirement.js';

export interface NodeWorkerOutputFailure {
  readonly instanceId: string;
  readonly stream: ProducerStreamIdentity;
  readonly sequence: number | null;
  readonly transfer: NodeBulkIdentity | null;
  readonly cause: unknown;
}

interface StreamAssembly {
  readonly stream: ProducerStreamIdentity;
  readonly instanceId: string;
  readonly cancellation: AbortController;
  readonly detach: () => void;
  readonly received: (serialized: string, sequence: number) => void;
  readonly failed: (failure: NodeWorkerOutputFailure) => void;
  produced: number;
  pending: { readonly frame: NodeWorkerOutputChunk; transfer: NodeBulkIdentity | null; release(): void } | null;
}

interface StreamRoute { readonly instanceId: string; readonly owner: StreamAssembly | null }

export interface NodeWorkerOutputAssemblerOptions {
  readonly session: NodeSessionIdentity;
  readonly instanceIds: ReadonlySet<string>;
  readonly signal: AbortSignal;
  readonly limits?: Partial<NodeBulkLimits>;
  readonly budget?: NodeOutputAssemblyBudget;
  readonly now: () => number;
  readonly scheduleTimeout?: (callback: () => void, delayMs: number) => { cancel(): void };
  validate(): void;
  /** Owns complete session retirement when assembly authority fails, without per-stream cancellation fanout. */
  failed(error: unknown): void;
}

/** Bounds partial output across all instance pipes without retaining another replay history. */
export class NodeWorkerOutputAssembler {
  readonly #session: NodeSessionIdentity;
  readonly #instances: ReadonlySet<string>;
  readonly #streams = new Map<string, StreamRoute>();
  readonly #activeInstances = new Map<string, StreamAssembly>();
  readonly #transfers: NodeBulkTransfers;
  readonly #budget: NodeOutputAssemblyBudget;
  readonly #detach: () => void;
  #closed = false;

  constructor(private readonly options: NodeWorkerOutputAssemblerOptions) {
    const session = parseNodeSessionIdentity(options.session);
    if (!session || !options.instanceIds.size || options.instanceIds.size > 64
      || [...options.instanceIds].some((id) => !isExecutionIdentity(id))) throw new TypeError('Invalid worker output namespace');
    this.#session = Object.freeze(session);
    this.#instances = new Set(options.instanceIds);
    this.options = Object.freeze({ ...options });
    const limits = { ...NODE_WORKER_OUTPUT_ASSEMBLY, ...options.limits };
    this.#budget = options.budget ?? new NodeOutputAssemblyBudget(limits.maxBytes);
    this.#transfers = new NodeBulkTransfers({ session, authoritySignal: options.signal, now: options.now, limits,
      scheduleTimeout: (callback, delayMs) => (options.scheduleTimeout ?? scheduleTimeout)(() => {
        try { this.#validate(); callback(); this.prune(); }
        catch (error) { this.#failPipe(error); }
      }, delayMs),
    });
    const close = () => this.close();
    this.#detach = () => options.signal.removeEventListener('abort', close);
    options.signal.addEventListener('abort', close, { once: true });
    if (options.signal.aborted) this.close();
  }

  install(instanceId: string, value: ProducerStreamIdentity, signal: AbortSignal,
    received: StreamAssembly['received'], failed: StreamAssembly['failed'], afterSequence = 0): void {
    this.#validate();
    const stream = parseProducerStreamIdentity(value);
    if (!stream || !sameNodeSession(stream, this.#session) || !this.#instances.has(instanceId)
      || !Number.isSafeInteger(afterSequence) || afterSequence < 0 || afterSequence > MAX_NODE_OUTPUT_SEQUENCE) throw protocol();
    const key = producerStreamKey(stream);
    if (this.#streams.has(key)) throw new TypeError('Worker output stream cannot be rebound');
    if (this.#streams.size >= MAX_NODE_STREAM_IDENTITIES) throw new NodeStreamIdentityExhaustedError();
    signal.throwIfAborted();
    const retire = () => this.retire(stream);
    this.#streams.set(key, { instanceId, owner: { stream: Object.freeze(stream), instanceId, received, failed, produced: afterSequence, pending: null,
      cancellation: new AbortController(), detach: () => signal.removeEventListener('abort', retire) } });
    signal.addEventListener('abort', retire, { once: true });
  }

  receive(instanceId: string, text: string): 'record' | 'chunk' | 'retired' {
    this.#validate();
    const frame = parseNodeWorkerOutputText(text);
    if (!frame || !this.#instances.has(instanceId) || frame.instanceId !== instanceId || !sameNodeSession(frame.stream, this.#session)) throw protocol();
    const key = producerStreamKey(frame.stream);
    const route = this.#streams.get(key);
    if (route && route.instanceId !== instanceId) throw protocol();
    if (!route?.owner) return 'retired';
    const owner = route.owner;
    let serialized: string | null;
    try { serialized = this.#append(owner, frame, key); }
    catch (error) {
      this.#validate();
      this.#fail(owner, error, frame);
      return 'retired';
    }
    this.#validate();
    if (owner.cancellation.signal.aborted) return 'retired';
    if (serialized === null) return 'chunk';
    owner.produced = frame.sequence;
    try { owner.received(serialized, frame.sequence); }
    catch (error) {
      this.#validate();
      this.#fail(owner, error, frame);
      return 'retired';
    }
    return owner.cancellation.signal.aborted ? 'retired' : 'record';
  }

  retire(stream: ProducerStreamIdentity): void {
    const owner = this.#streams.get(producerStreamKey(stream))?.owner;
    if (owner) this.#retire(owner);
  }

  receiveRetirement(instanceId: string, text: string): void {
    this.#validate();
    const frame = parseNodeWorkerOutputRetirementText(text);
    if (!frame || !this.#instances.has(instanceId) || frame.instanceId !== instanceId || !sameNodeSession(frame.stream, this.#session)) throw protocol();
    const route = this.#streams.get(producerStreamKey(frame.stream));
    if (route && route.instanceId !== instanceId) throw protocol();
    if (route?.owner) this.#fail(route.owner, new NodeWorkerTransportError('NODE_WORKER_CLOSED'));
  }

  prune(): void {
    this.#validate();
    this.#transfers.prune();
    for (const owner of this.#activeInstances.values()) {
      if (owner.pending?.transfer && !this.#transfers.status(owner.pending.transfer)) {
        this.#fail(owner, new NodeWorkerTransportError('NODE_WORKER_TIMEOUT'));
      }
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#detach();
    for (const { owner } of this.#streams.values()) if (owner) this.#retire(owner);
    this.#streams.clear();
    this.#transfers.close();
  }

  /** Reconciles expired transfers and checks authority; observation may retire streams or throw on session failure. */
  get bufferedBytes(): number {
    if (this.#closed) return 0;
    this.prune();
    let bytes = 0;
    for (const owner of this.#activeInstances.values()) bytes += owner.pending?.frame.descriptor.byteLength ?? 0;
    return bytes;
  }

  #append(owner: StreamAssembly, frame: NodeWorkerOutputChunk, key: string): string | null {
    owner.cancellation.signal.throwIfAborted();
    if (!owner.pending) {
      if (frame.sequence !== owner.produced + 1 || frame.chunk.offset !== 0) throw protocol();
      if (this.#activeInstances.has(owner.instanceId)) throw new NodeBulkError('NODE_CAPACITY', 'An instance output record is already in flight');
      owner.pending = { frame, transfer: null, release: this.#budget.reserve(frame.descriptor.byteLength) };
      this.#activeInstances.set(owner.instanceId, owner);
      owner.pending.transfer = this.#transfers.reserve(owner, frame.descriptor, owner.cancellation.signal);
    }
    const pending = owner.pending;
    if (!pending.transfer || frame.sequence !== pending.frame.sequence || frame.chunk.transfer.transferId !== pending.frame.chunk.transfer.transferId
      || frame.descriptor.byteLength !== pending.frame.descriptor.byteLength || frame.descriptor.sha256 !== pending.frame.descriptor.sha256) throw protocol();
    const received = this.#transfers.append(pending.transfer, frame.chunk.offset, Buffer.from(frame.chunk.data, 'base64'));
    if (received !== frame.descriptor.byteLength) return null;
    this.#transfers.complete(pending.transfer);
    const bytes = this.#transfers.take(pending.transfer, owner);
    try {
      const serialized = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      const output = parseNodeOutputText(serialized);
      if (!output || producerStreamKey(output.stream) !== key || output.sequence !== frame.sequence) throw protocol();
      return serialized;
    } finally { bytes.fill(0); this.#release(owner); }
  }

  #validate(): void {
    if (this.#closed) throw protocol();
    try {
      this.options.signal.throwIfAborted();
      this.options.validate();
      this.options.signal.throwIfAborted();
      if (this.#closed) throw protocol();
    } catch (error) { this.#failPipe(error); throw error; }
  }

  #fail(owner: StreamAssembly, cause: unknown, frame = owner.pending?.frame): void {
    if (this.#streams.get(producerStreamKey(owner.stream))?.owner !== owner) return;
    const failure = Object.freeze({ instanceId: owner.instanceId, stream: owner.stream,
      sequence: frame?.sequence ?? null, transfer: frame?.chunk.transfer ?? null, cause });
    this.#retire(owner);
    try { owner.failed(failure); } catch { /* Failure observers cannot restore a partially received stream. */ }
  }

  #failPipe(error: unknown): void {
    if (this.#closed) return;
    this.close();
    try { this.options.failed(error); } catch { /* The logical authority cannot be restored by an observer. */ }
  }

  #retire(owner: StreamAssembly): void {
    this.#streams.set(producerStreamKey(owner.stream), { instanceId: owner.instanceId, owner: null });
    owner.detach();
    owner.cancellation.abort(new NodeBulkError('NODE_BULK_UNAVAILABLE', 'Worker output stream retired'));
    this.#release(owner);
  }

  #release(owner: StreamAssembly): void {
    owner.pending?.release(); owner.pending = null;
    if (this.#activeInstances.get(owner.instanceId) === owner) this.#activeInstances.delete(owner.instanceId);
  }
}

function protocol(): NodeWorkerTransportError { return new NodeWorkerTransportError('NODE_WORKER_PROTOCOL'); }
function scheduleTimeout(callback: () => void, delayMs: number): { cancel(): void } {
  const timer = setTimeout(callback, delayMs);
  timer.unref();
  return { cancel: () => clearTimeout(timer) };
}
