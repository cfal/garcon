import { MAX_NODE_OUTPUT_SEQUENCE, parseProducerStreamIdentity, producerStreamKey, type ProducerStreamIdentity } from '@garcon/server-agent-interface';
import { isExecutionIdentity } from '../../../common/execution-location.js';
import { parseNodeSessionIdentity, sameNodeSession, type NodeSessionIdentity } from '../../../common/node-operation.js';
import { MAX_NODE_STREAM_IDENTITIES, NodeStreamIdentityExhaustedError } from '../replay-cache.js';
import { NodeWorkerOutputAssembler } from './output-assembler.js';
import type { NodeOutputAssemblyBudget } from './output-budget.js';
import type { NodeOutputReplayCursor } from './output-delivery.js';
import { parseNodeWorkerOutputDeliveryText } from './output-delivery-protocol.js';
import { parseNodeWorkerOutputText } from './output-protocol.js';
import { parseNodeWorkerOutputRetirementText } from './output-retirement.js';
import { NodeWorkerTransportError } from './framing.js';
import { parseNodeWorkerOutputSuspensionText } from './service-protocol.js';

interface ReceiverStream {
  readonly instanceId: string;
  readonly stream: ProducerStreamIdentity;
  readonly signal: AbortSignal;
  readonly detach: () => void;
  readonly received: (serialized: string, sequence: number) => void;
  readonly failed: (error: unknown) => void;
}

interface ReceiverRoute { readonly instanceId: string; readonly owner: ReceiverStream | null }

export interface NodeOutputReceiverAttempt {
  readonly connectionId: number;
  readonly generation: number;
}

interface ReceiverAttempt {
  readonly token: NodeOutputReceiverAttempt;
  readonly assembler: NodeWorkerOutputAssembler;
  readonly detach: () => void;
}

export interface NodeWorkerOutputDeliveryReceiverOptions {
  readonly session: NodeSessionIdentity;
  readonly instanceIds: ReadonlySet<string>;
  readonly signal: AbortSignal;
  readonly budget: NodeOutputAssemblyBudget;
  readonly now: () => number;
  readonly scheduleTimeout?: (callback: () => void, delayMs: number) => { cancel(): void };
  validate(): void;
  failed(error: unknown): void;
}

/** Retains immutable publication routes while replacing only assembly for each physical delivery attempt. */
export class NodeWorkerOutputDeliveryReceiver {
  readonly #session: NodeSessionIdentity;
  readonly #instances: ReadonlySet<string>;
  readonly #streams = new Map<string, ReceiverRoute>();
  readonly #detach: () => void;
  #attempt: ReceiverAttempt | null = null;
  #lastConnection = 0;
  #lastGeneration = 0;
  #closed = false;

  constructor(private readonly options: NodeWorkerOutputDeliveryReceiverOptions) {
    const session = parseNodeSessionIdentity(options.session);
    if (!session || !options.instanceIds.size || options.instanceIds.size > 64
      || [...options.instanceIds].some((id) => !isExecutionIdentity(id))) throw protocol();
    this.#session = Object.freeze(session);
    this.#instances = new Set(options.instanceIds);
    this.options = Object.freeze({ ...options });
    const close = () => this.close();
    this.#detach = () => options.signal.removeEventListener('abort', close);
    options.signal.addEventListener('abort', close, { once: true });
    if (options.signal.aborted) this.close();
  }

  install(instanceId: string, value: ProducerStreamIdentity, signal: AbortSignal,
    received: ReceiverStream['received'], failed: ReceiverStream['failed']): void {
    this.#validate();
    const stream = parseProducerStreamIdentity(value);
    if (!stream || !sameNodeSession(stream, this.#session) || !this.#instances.has(instanceId)) throw protocol();
    const key = producerStreamKey(stream);
    if (this.#streams.has(key)) throw new TypeError('Output publication route cannot be rebound');
    if (this.#streams.size >= MAX_NODE_STREAM_IDENTITIES) throw new NodeStreamIdentityExhaustedError();
    signal.throwIfAborted();
    const retire = () => this.retire(stream);
    const owner: ReceiverStream = { instanceId, stream: Object.freeze(stream), signal, received, failed,
      detach: () => signal.removeEventListener('abort', retire) };
    this.#streams.set(key, { instanceId, owner });
    signal.addEventListener('abort', retire, { once: true });
    try { if (this.#attempt) this.#install(this.#attempt, owner, 0); }
    catch (error) { this.retire(stream); throw error; }
  }

  begin(connectionId: number, generation: number, cursors: readonly NodeOutputReplayCursor[], signal: AbortSignal): NodeOutputReceiverAttempt {
    this.#validate(); signal.throwIfAborted();
    if (!Number.isSafeInteger(connectionId) || connectionId < 1 || connectionId < this.#lastConnection
      || !Number.isSafeInteger(generation) || generation <= this.#lastGeneration) throw protocol();
    const positions = new Map<string, number>();
    for (const cursor of cursors) {
      const key = producerStreamKey(cursor.stream);
      if (!this.#streams.get(key)?.owner || positions.has(key) || !Number.isSafeInteger(cursor.afterSequence)
        || cursor.afterSequence < 0 || cursor.afterSequence > MAX_NODE_OUTPUT_SEQUENCE) throw protocol();
      positions.set(key, cursor.afterSequence);
    }
    for (const [key, { owner }] of this.#streams) if (owner && !positions.has(key)) throw protocol();
    this.#lastConnection = connectionId; this.#lastGeneration = generation;
    if (this.#attempt) this.suspend(this.#attempt.token);
    const token = Object.freeze({ connectionId, generation });
    const assembler = new NodeWorkerOutputAssembler({ ...this.options, instanceIds: this.#instances,
      failed: (error) => this.#fail(error) });
    const suspend = () => this.suspend(token);
    const attempt: ReceiverAttempt = { token, assembler, detach: () => signal.removeEventListener('abort', suspend) };
    this.#attempt = attempt;
    signal.addEventListener('abort', suspend, { once: true });
    try {
      for (const [key, { owner }] of this.#streams) if (owner) this.#install(attempt, owner, positions.get(key)!);
      this.#validate(); signal.throwIfAborted();
      if (this.#attempt !== attempt) throw protocol();
      return token;
    } catch (error) { this.suspend(token); throw error; }
  }

  receive(text: string): 'record' | 'chunk' | 'retired' {
    this.#validate();
    const frame = parseNodeWorkerOutputDeliveryText(text);
    if (!frame || !sameNodeSession(frame.session, this.#session)) throw protocol();
    const attempt = this.#attempt;
    if (!attempt || frame.connectionId !== attempt.token.connectionId || frame.generation !== attempt.token.generation) return 'retired';
    const payload = parseNodeWorkerOutputText(frame.payload)!;
    const route = this.#streams.get(producerStreamKey(payload.stream));
    if (!this.#instances.has(payload.instanceId) || route && route.instanceId !== payload.instanceId) throw protocol();
    return attempt.assembler.receive(payload.instanceId, frame.payload);
  }

  receiveRetirement(text: string): void {
    this.#validate();
    const frame = parseNodeWorkerOutputRetirementText(text);
    if (!frame || !sameNodeSession(frame.stream, this.#session) || !this.#instances.has(frame.instanceId)) throw protocol();
    const route = this.#streams.get(producerStreamKey(frame.stream));
    if (route && route.instanceId !== frame.instanceId) throw protocol();
    if (!route) {
      if (this.#streams.size >= MAX_NODE_STREAM_IDENTITIES) return;
      this.#streams.set(producerStreamKey(frame.stream), { instanceId: frame.instanceId, owner: null });
      return;
    }
    if (!route.owner) return;
    this.#failStream(route.owner, new NodeWorkerTransportError('NODE_WORKER_CLOSED'));
  }

  /** Returns true once for the current attempt so its owner can gate admissions and start recovery. */
  receiveSuspension(text: string): boolean {
    this.#validate();
    const frame = parseNodeWorkerOutputSuspensionText(text);
    if (!frame || !sameNodeSession(frame.session, this.#session)) throw protocol();
    const attempt = this.#attempt;
    return !!attempt && frame.connectionId === attempt.token.connectionId && frame.generation === attempt.token.generation
      && this.suspend(attempt.token);
  }

  suspend(token: NodeOutputReceiverAttempt): boolean {
    const attempt = this.#attempt;
    if (!attempt || attempt.token !== token) return false;
    this.#attempt = null; attempt.detach(); attempt.assembler.close();
    return true;
  }

  retire(stream: ProducerStreamIdentity): void {
    const key = producerStreamKey(stream);
    const owner = this.#streams.get(key)?.owner;
    if (!owner) return;
    this.#streams.set(key, { instanceId: owner.instanceId, owner: null }); owner.detach();
    this.#attempt?.assembler.retire(owner.stream);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true; this.#detach();
    if (this.#attempt) this.suspend(this.#attempt.token);
    for (const { owner } of this.#streams.values()) owner?.detach();
    this.#streams.clear();
  }

  #install(attempt: ReceiverAttempt, owner: ReceiverStream, afterSequence: number): void {
    attempt.assembler.install(owner.instanceId, owner.stream, owner.signal,
      (serialized, sequence) => {
        if (this.#attempt === attempt && this.#streams.get(producerStreamKey(owner.stream))?.owner === owner) owner.received(serialized, sequence);
      },
      (failure) => {
        if (this.#attempt === attempt) this.#failStream(owner, failure.cause);
      }, afterSequence);
  }

  #failStream(owner: ReceiverStream, error: unknown): void {
    if (this.#streams.get(producerStreamKey(owner.stream))?.owner !== owner) return;
    this.retire(owner.stream);
    try { owner.failed(error); } catch { /* Publication authority is already retired. */ }
  }

  #validate(): void {
    if (this.#closed) throw protocol();
    try {
      this.options.signal.throwIfAborted(); this.options.validate(); this.options.signal.throwIfAborted();
      if (this.#closed) throw protocol();
    } catch (error) { this.#fail(error); throw error; }
  }

  #fail(error: unknown): void {
    if (this.#closed) return;
    this.close();
    try { this.options.failed(error); } catch { /* The owner must retire the failed logical session. */ }
  }
}

function protocol(): NodeWorkerTransportError { return new NodeWorkerTransportError('NODE_WORKER_PROTOCOL'); }
