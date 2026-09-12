import { parseProducerStreamIdentity, producerStreamKey, type AgentEmissionSink, type ProducerStreamIdentity } from '@garcon/server-agent-interface';
import { parseNodeOperationIdentity, parseNodeSessionIdentity, sameNodeSession, type NodeOperationIdentity, type NodeSessionIdentity } from '../../common/node-operation.js';
import { DomainError } from '../lib/domain-error.js';
import type { ProviderExecutionOutput } from '../execution-nodes/provider-execution.js';
import type { NodeExecutionWireCapabilities } from './execution-wire-adapter.js';
import { isNodeOperationGrant, type NodeOperationGrant } from './operation-table.js';
import { MAX_NODE_STREAM_IDENTITIES, NodeStreamIdentityExhaustedError } from './replay-cache.js';

interface OutputGrant {
  readonly identity: ProducerStreamIdentity;
  readonly createOutput: (isRunLive: (runId: string) => boolean) => AgentEmissionSink;
  readonly validate: () => void;
  readonly cancellation: AbortController;
  readonly detach: () => void;
}

interface OperationOutput {
  readonly owner: OutputGrant;
  readonly sink: ProviderExecutionOutput;
  readonly cancellation: AbortController;
  readonly detach: () => void;
}

export interface NodeExecutionOutputGrantsOptions {
  readonly session: NodeSessionIdentity;
  readonly signal: AbortSignal;
  readonly maxStreams?: number;
  readonly maxOperations?: number;
}

/** Resolves dispatch only through an immutable host-installed operation-to-publisher binding. */
export class NodeExecutionOutputGrants implements Pick<NodeExecutionWireCapabilities, 'output'> {
  readonly #session: NodeSessionIdentity;
  readonly #streams = new Map<string, OutputGrant | null>();
  readonly #operations = new Map<string, OperationOutput>();
  readonly #consumed = new WeakSet<NodeOperationGrant>();
  readonly #detach: () => void;
  readonly #maxStreams: number;
  readonly #maxOperations: number;
  #closed = false;

  constructor(private readonly options: NodeExecutionOutputGrantsOptions) {
    const session = parseNodeSessionIdentity(options.session);
    if (!session) throw new TypeError('Invalid output grant namespace');
    this.#session = Object.freeze(session);
    this.#maxStreams = options.maxStreams ?? MAX_NODE_STREAM_IDENTITIES;
    this.#maxOperations = options.maxOperations ?? 16_384;
    if (![this.#maxStreams, this.#maxOperations].every((limit) => Number.isSafeInteger(limit) && limit > 0 && limit <= 65_536)) throw new TypeError('Invalid output grant capacity');
    const close = () => this.close();
    options.signal.addEventListener('abort', close, { once: true });
    this.#detach = () => options.signal.removeEventListener('abort', close);
    if (options.signal.aborted) this.close();
  }

  install(stream: ProducerStreamIdentity, createOutput: OutputGrant['createOutput'], signal: AbortSignal, validate: () => void): void {
    this.#assertOpen();
    const identity = parseProducerStreamIdentity(stream);
    if (!identity || !sameNodeSession(identity, this.#session)) throw unavailable();
    const key = producerStreamKey(identity);
    if (this.#streams.has(key)) throw new TypeError('Output stream cannot be rebound');
    if (this.#streams.size >= this.#maxStreams) throw new NodeStreamIdentityExhaustedError();
    signal.throwIfAborted();
    const cancellation = new AbortController();
    const retire = () => this.retire(identity);
    this.#streams.set(key, { identity: Object.freeze(identity), cancellation, createOutput, validate,
      detach: () => signal.removeEventListener('abort', retire) });
    signal.addEventListener('abort', retire, { once: true });
  }

  bind(operation: NodeOperationGrant, stream: ProducerStreamIdentity): void {
    if (!isNodeOperationGrant(operation)) throw new TypeError('Execution output requires an issued operation grant');
    const { identity, signal } = operation;
    const operationId = this.#operationId(identity);
    const owner = this.#stream(stream);
    if (this.#consumed.has(operation) || this.#operations.has(operationId)) throw new TypeError('Execution output operation cannot be rebound');
    if (this.#operations.size >= this.#maxOperations) throw capacity();
    signal.throwIfAborted();
    this.#consumed.add(operation);
    const cancellation = new AbortController();
    const release = () => this.release(identity);
    const isRunLive = (runId: string) => !cancellation.signal.aborted && operation.isRunLive(runId);
    const output = owner.createOutput(isRunLive);
    const emit = output.emit;
    signal.throwIfAborted();
    if (this.#stream(stream) !== owner) throw unavailable();
    const entry: OperationOutput = { owner, cancellation, detach: () => signal.removeEventListener('abort', release), sink: Object.freeze<ProviderExecutionOutput>({ signal: owner.cancellation.signal, emit: (event) => {
      this.#assertOpen();
      owner.cancellation.signal.throwIfAborted();
      owner.validate();
      this.#assertOpen();
      owner.cancellation.signal.throwIfAborted();
      if ('runId' in event && !operation.ownsRun(event.runId)) throw unavailable();
      if ((event.type === 'notice' || event.type === 'run-ended') && !isRunLive(event.runId)) return;
      Reflect.apply(emit, output, [event]);
    } }) };
    this.#operations.set(operationId, entry);
    signal.addEventListener('abort', release, { once: true });
  }

  output(stream: ProducerStreamIdentity, identity: NodeOperationIdentity): ProviderExecutionOutput {
    const operationId = this.#operationId(identity);
    const owner = this.#stream(stream);
    const operation = this.#operations.get(operationId);
    if (operation?.owner !== owner) throw unavailable();
    return operation.sink;
  }

  /** Removes dispatch lookup while late provider callbacks retain their original open publisher. */
  release(identity: NodeOperationIdentity): void {
    const operationId = this.#operationId(identity);
    const operation = this.#operations.get(operationId);
    operation?.detach();
    operation?.cancellation.abort();
    this.#operations.delete(operationId);
  }

  retire(stream: ProducerStreamIdentity): void {
    if (this.#closed) return;
    const key = producerStreamKey(stream);
    const owner = this.#streams.get(key);
    if (!owner) return;
    this.#streams.set(key, null);
    this.#retire(owner);
    for (const [id, operation] of this.#operations) if (operation?.owner === owner) {
      operation.detach();
      operation.cancellation.abort();
      this.#operations.delete(id);
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#detach();
    for (const owner of this.#streams.values()) if (owner) this.#retire(owner);
    for (const operation of this.#operations.values()) { operation.detach(); operation.cancellation.abort(); }
    this.#streams.clear();
    this.#operations.clear();
  }

  #retire(owner: OutputGrant): void { owner.detach(); owner.cancellation.abort(unavailable()); }

  #stream(value: ProducerStreamIdentity): OutputGrant {
    this.#assertOpen();
    const identity = parseProducerStreamIdentity(value);
    if (!identity || !sameNodeSession(identity, this.#session)) throw unavailable();
    const owner = this.#streams.get(producerStreamKey(identity));
    if (!owner) throw unavailable();
    owner.cancellation.signal.throwIfAborted();
    return owner;
  }

  #operationId(value: NodeOperationIdentity): string {
    this.#assertOpen();
    const identity = parseNodeOperationIdentity(value);
    if (!identity || !sameNodeSession(identity, this.#session)) throw unavailable();
    return identity.operationId;
  }

  #assertOpen(): void { if (this.#closed || this.options.signal.aborted) throw unavailable(); }
}

function unavailable(): DomainError { return new DomainError('NODE_SESSION_EXPIRED', 'Execution output grant is unavailable', 409); }
function capacity(): DomainError { return new DomainError('NODE_CAPACITY', 'Execution output grant capacity exceeded', 429); }
