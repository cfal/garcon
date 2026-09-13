import { isExecutionIdentity } from '../../common/execution-location.js';
import { parseNodeOperationIdentity, parseNodeSessionIdentity, sameNodeSession, type NodeOperationIdentity, type NodeSessionIdentity } from '../../common/node-operation.js';
import type { NodeExecutionReceipt } from '../execution-node/operation-table.js';
import { DomainError } from '../lib/domain-error.js';
import type { NodeExecutionClient } from './transport/execution-channel.js';

export interface NodeExecutionConnection {
  readonly session: NodeSessionIdentity;
  readonly connectionId: number;
  readonly signal: AbortSignal;
  execution(instanceId: string): Pick<NodeExecutionClient, 'call'>;
  validate(): void;
}

export interface NodeTrackedExecution {
  readonly identity: NodeOperationIdentity;
  readonly receipt: NodeExecutionReceipt | null;
  /** Captures the current run; false includes disconnected or unconfirmed termination. */
  interrupt(): Promise<boolean>;
  advanceRun(expectedRunId: string, runId: string): void;
  retire(): void;
}

export interface NodeExecutionReconciliationOptions {
  readonly session: NodeSessionIdentity;
  readonly instanceIds: ReadonlySet<string>;
  readonly signal: AbortSignal;
  readonly maxIdentities?: number;
  validate(): void;
}

interface StopIntent {
  readonly runId: string;
  submitted: boolean;
  pending: Promise<boolean> | null;
}

interface TrackedExecution {
  readonly identity: NodeOperationIdentity;
  readonly instanceId: string;
  readonly cancellation: AbortController;
  runId: string;
  readVersion: number;
  receipt: NodeExecutionReceipt | null;
  stop: StopIntent | null;
}

interface PhysicalConnection {
  readonly connection: NodeExecutionConnection;
  readonly detach: () => void;
}

/** Retains process-local receipts and exact-run Stop intents without replaying execution mutations. */
export class NodeExecutionReconciliation {
  readonly #session: NodeSessionIdentity;
  readonly #executions = new Map<string, TrackedExecution | null>();
  readonly #closing = new AbortController();
  readonly #detach: () => void;
  readonly #maxIdentities: number;
  #physical: PhysicalConnection | null = null;
  #lastConnectionId = 0;

  constructor(private readonly options: NodeExecutionReconciliationOptions) {
    const session = parseNodeSessionIdentity(options.session);
    this.#maxIdentities = options.maxIdentities ?? 16_384;
    if (!session || !options.instanceIds.size || options.instanceIds.size > 64
      || [...options.instanceIds].some((id) => !isExecutionIdentity(id))
      || !Number.isSafeInteger(this.#maxIdentities) || this.#maxIdentities < 1 || this.#maxIdentities > 65_536) throw invalid();
    this.#session = Object.freeze(session);
    this.options = Object.freeze({ ...options, instanceIds: new Set(options.instanceIds) });
    const close = () => this.close();
    this.#detach = () => options.signal.removeEventListener('abort', close);
    options.signal.addEventListener('abort', close, { once: true });
    if (options.signal.aborted) this.close();
  }

  track(instanceId: string, value: NodeOperationIdentity, runId: string): NodeTrackedExecution {
    this.#validate();
    const identity = parseNodeOperationIdentity(value);
    if (!identity || !sameNodeSession(identity, this.#session) || !this.options.instanceIds.has(instanceId) || !isExecutionIdentity(runId)) throw invalid();
    if (this.#executions.has(identity.operationId)) throw new TypeError('Execution receipt identity cannot be rebound');
    if (this.#executions.size >= this.#maxIdentities) throw new DomainError('NODE_CAPACITY', 'Execution receipt identity capacity exceeded', 429);
    const owner: TrackedExecution = { identity: Object.freeze(identity), instanceId, runId, readVersion: 0,
      receipt: null, stop: null, cancellation: new AbortController() };
    this.#executions.set(identity.operationId, owner);
    return Object.freeze({ identity: owner.identity, get receipt() { return owner.receipt ? structuredClone(owner.receipt) : null; },
      interrupt: () => this.#interrupt(owner),
      advanceRun: (expectedRunId: string, nextRunId: string) => {
        this.#validateOwner(owner);
        if (owner.runId !== expectedRunId || !isExecutionIdentity(nextRunId) || nextRunId === expectedRunId) throw invalid();
        owner.runId = nextRunId; owner.receipt = null; owner.stop = null;
      },
      retire: () => this.#retire(owner),
    });
  }

  attach(connection: NodeExecutionConnection): void {
    this.#validate();
    const previous = this.#physical;
    const previousId = this.#lastConnectionId;
    if (!sameNodeSession(connection.session, this.#session) || !Number.isSafeInteger(connection.connectionId)
      || connection.connectionId <= this.#lastConnectionId) throw invalid();
    connection.signal.throwIfAborted(); connection.validate(); this.#validate();
    if (this.#physical !== previous || this.#lastConnectionId !== previousId) throw unavailable();
    this.#lastConnectionId = connection.connectionId;
    const disconnect = () => { if (this.#physical === physical) { physical.detach(); this.#physical = null; } };
    const { execution, validate } = connection;
    const physical: PhysicalConnection = { connection: Object.freeze({
      session: this.#session, connectionId: connection.connectionId, signal: connection.signal,
      execution: (instanceId: string) => Reflect.apply(execution, connection, [instanceId]),
      validate: () => Reflect.apply(validate, connection, []),
    }),
      detach: () => connection.signal.removeEventListener('abort', disconnect) };
    this.#physical?.detach(); this.#physical = physical;
    connection.signal.addEventListener('abort', disconnect, { once: true });
    if (connection.signal.aborted) disconnect();
  }

  async reconcile(connectionId: number, signal: AbortSignal): Promise<void> {
    this.#validate(); signal.throwIfAborted();
    const physical = this.#physical;
    if (!physical || physical.connection.connectionId !== connectionId) throw unavailable();
    for (const owner of this.#executions.values()) {
      this.#validatePhysical(physical); signal.throwIfAborted();
      if (!owner) continue;
      await this.#read(owner, physical, signal);
      this.#validatePhysical(physical); signal.throwIfAborted();
      if (this.#executions.get(owner.identity.operationId) !== owner) continue;
      const stop = owner.stop;
      if (stop && !stop.submitted) {
        await this.#sendStop(owner, stop, physical, signal);
        if (stop.submitted && this.#executions.get(owner.identity.operationId) === owner) await this.#read(owner, physical, signal);
      }
      this.#validatePhysical(physical); signal.throwIfAborted();
    }
  }

  close(): void {
    if (this.#closing.signal.aborted) return;
    this.#closing.abort(unavailable()); this.#detach(); this.#physical?.detach(); this.#physical = null;
    for (const owner of this.#executions.values()) if (owner) this.#retire(owner);
    this.#executions.clear();
  }

  async #interrupt(owner: TrackedExecution): Promise<boolean> {
    try {
      this.#validateOwner(owner);
      const stop = owner.stop ??= { runId: owner.runId, submitted: false, pending: null };
      if (stop.pending) return await stop.pending;
      const physical = this.#physical;
      if (!physical) return false;
      const pending = (async () => {
        await this.#read(owner, physical, this.#closing.signal);
        return this.#sendStop(owner, stop, physical, this.#closing.signal);
      })();
      stop.pending = pending;
      try { return await pending; }
      finally { if (stop.pending === pending) stop.pending = null; }
    } catch { return false; }
  }

  async #read(owner: TrackedExecution, physical: PhysicalConnection, signal: AbortSignal): Promise<void> {
    this.#validateOwner(owner); this.#validatePhysical(physical); signal.throwIfAborted();
    const runId = owner.runId;
    const version = ++owner.readVersion;
    const result = await physical.connection.execution(owner.instanceId).call({ method: 'status', identity: owner.identity },
      AbortSignal.any([signal, this.#closing.signal, physical.connection.signal, owner.cancellation.signal]));
    this.#validatePhysical(physical); signal.throwIfAborted();
    if (owner.cancellation.signal.aborted || owner.runId !== runId || owner.readVersion !== version) return;
    if (result.kind !== 'status') throw unavailable();
    if (result.receipt && (!sameNodeSession(result.receipt.identity, owner.identity)
      || result.receipt.identity.operationId !== owner.identity.operationId)) throw invalid();
    owner.receipt = result.receipt ? structuredClone(result.receipt) : null;
  }

  async #sendStop(owner: TrackedExecution, stop: StopIntent, physical: PhysicalConnection, signal: AbortSignal): Promise<boolean> {
    this.#validateOwner(owner); this.#validatePhysical(physical); signal.throwIfAborted();
    const receipt = owner.receipt;
    if (owner.stop !== stop || owner.runId !== stop.runId || !receipt || receipt.runId !== stop.runId) return false;
    if (receipt.abort !== null) { stop.submitted = true; return receipt.abort === 'requested'; }
    if (stop.submitted || receipt.phase !== 'prepared' && receipt.native !== 'possible') return false;
    // Admission ambiguity cannot turn a Stop into an automatic second mutation.
    stop.submitted = true;
    const result = await physical.connection.execution(owner.instanceId).call({ method: 'abort-run', identity: owner.identity, runId: stop.runId },
      AbortSignal.any([signal, this.#closing.signal, physical.connection.signal, owner.cancellation.signal]));
    this.#validatePhysical(physical); signal.throwIfAborted();
    if (owner.cancellation.signal.aborted || this.#executions.get(owner.identity.operationId) !== owner) return false;
    if (owner.stop !== stop) return false;
    if (result.kind === 'rejected') stop.submitted = false;
    return result.kind === 'abort-result' && result.requested;
  }

  #retire(owner: TrackedExecution): void {
    if (this.#executions.get(owner.identity.operationId) !== owner) return;
    this.#executions.set(owner.identity.operationId, null);
    owner.cancellation.abort(unavailable()); owner.stop = null; owner.receipt = null;
  }

  #validateOwner(owner: TrackedExecution): void {
    this.#validate(); owner.cancellation.signal.throwIfAborted();
    if (this.#executions.get(owner.identity.operationId) !== owner) throw unavailable();
  }

  #validatePhysical(physical: PhysicalConnection): void {
    this.#validate(); physical.connection.signal.throwIfAborted(); physical.connection.validate();
    this.#validate();
    if (this.#physical !== physical) throw unavailable();
  }

  #validate(): void {
    this.#closing.signal.throwIfAborted(); this.options.signal.throwIfAborted(); this.options.validate();
    this.#closing.signal.throwIfAborted(); this.options.signal.throwIfAborted();
  }
}

function invalid(): TypeError { return new TypeError('Invalid execution reconciliation identity'); }
function unavailable(): DomainError { return new DomainError('NODE_UNAVAILABLE', 'Execution receipt is unavailable', 409); }
