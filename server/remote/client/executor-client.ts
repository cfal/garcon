import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import {
  AgentCallError,
  type ExecutorInfo,
  type ExecutorAvailability,
} from '@garcon/server-agent-interface';
import { DEFAULT_RPC_TIMEOUT_MS, ExecutorRpc, ParkedRpcCalls, type RpcCallOptions } from '../transport/rpc.js';
import type { ExecutorRpcMethods, IntegrationManifest } from '../transport/rpc-protocol.js';
import type { SessionTransport } from '../transport/session-transport.js';
import type { WebSocketLink } from '../transport/websocket-link.js';
import { failureReason } from '../transport/failure-reason.js';
import { BULK_ACQUIRE_TIMEOUT_MS, EXECUTOR_RECONNECT_GRACE_MS } from '../transport/limits.js';
import { ExecutorRpcConnection } from '../transport/rpc-connection.js';
import { RpcAdmissionBudgets } from '../transport/rpc-admission.js';
import type { RpcLane } from '../transport/rpc-lane.js';
import type { BulkConnectionStatus } from '../transport/bulk-connection.js';
import { createLogger, type Logger } from '../../common/log.js';
import { ExecutorSessionLostError, reconnectTimedOut } from '../../common/executor-disconnect.js';
import type { ExecutorBulkStatus } from '../../../common/executors.js';
import { stableJsonStringify } from '../../../common/json.js';
import { sameContinuity, type ProtocolContinuity } from '../transport/protocol-compatibility.js';
import { RemoteExecutorGeneration, staleGeneration } from './executor-generation.js';
import { freezeInventory, validateManifest } from './executor-inventory.js';

export interface RemoteSessionBacking {
  readonly rpc: ExecutorRpc;
  readonly info: ExecutorInfo;
  readonly manifests: ReadonlyMap<string, IntegrationManifest>;
  readonly continuity: ProtocolContinuity;
}

// `timeoutMs` bounds both the wait and the call, as in `ExecutorRpc.call`:
// omitted, it is that call's default; null waits without a deadline.
export interface HeldCallOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number | null;
  // Bounds only the wait; see `ExecutorCallOptions`.
  readonly dispatchDeadline?: number;
  // Pins the call to one worker instance: a session of another instance fails it
  // as not dispatched. Cleanup belongs to the instance holding its resource. A
  // worker restart already fails waiting calls and forgets that instance's
  // bindings, so this guards the rule for any later caller.
  readonly instanceId?: string;
}

export interface HeldSession {
  readonly backing: RemoteSessionBacking;
  // The caller's deadline left after waiting, for the call itself.
  readonly timeoutMs: number | null;
}

// Hands out executor sessions. While the executor reconnects, a call waits for
// the replacement session within its own deadline instead of failing at once,
// as VS Code Remote holds requests while it reconnects.
export interface RemoteSessions {
  // The last installed session. A reconnect to the same worker keeps its
  // identity, capabilities, and manifests.
  latest(): RemoteSessionBacking;
  acquire(lane: RpcLane, options?: HeldCallOptions): Promise<HeldSession>;
  // Sends through a held session. A send that provably never left, because its
  // session retired first, is repeated on the next session of the same worker
  // within the caller's deadline.
  send<T>(lane: RpcLane, options: HeldCallOptions | undefined, send: (session: HeldSession) => Promise<T>): Promise<T>;
  call<K extends keyof ExecutorRpcMethods>(
    integrationId: string, method: K, request: ExecutorRpcMethods[K]['request'],
    options?: RpcCallOptions<ExecutorRpcMethods[K]['result']> & Pick<HeldCallOptions, 'dispatchDeadline' | 'instanceId'>,
  ): Promise<ExecutorRpcMethods[K]['result']>;
}

interface SessionWaiter {
  readonly lane: RpcLane;
  resolve(backing: RemoteSessionBacking): void;
  reject(error: Error): void;
}

class ExecutorConfigurationError extends Error {}

// A held call keeps up to this much of its deadline for the call itself, so it is
// not dispatched just before timing out with an unknown outcome.
const HELD_CALL_BUDGET_MS = 1_000;

export interface RemoteExecutorClientOptions {
  readonly reconnectGraceMs?: number;
  readonly logger?: Logger;
  // Validates controller-owned publication while the generation is still private.
  // The returned assignment runs synchronously before readiness or waiter delivery.
  readonly prepareGeneration?: (generation: RemoteExecutorGeneration) => () => void;
}

// How far a session's setup got, logged when it fails.
type SessionSetupStage = 'describe' | 'start-integrations' | 'resume-bindings' | 'activate';

export class RemoteExecutorClient {
  #generation: RemoteExecutorGeneration | null = null;
  #candidateGeneration: RemoteExecutorGeneration | null = null;
  #candidateBacking: RemoteSessionBacking | null = null;
  // Validated identities survive failed candidates and publication of other workers.
  readonly #workerInventories = new Map<string, { readonly instanceId: string; readonly fingerprint: string }>();
  readonly #instanceRuntimes = new Map<string, string>();
  readonly #listeners = new Set<(value: ExecutorAvailability) => void>();
  readonly #unsubscribe: () => void;
  #availability: ExecutorAvailability = 'offline';
  #current: RemoteSessionBacking | null = null;
  #bulkCurrent: RemoteSessionBacking | null = null;
  #connection: ExecutorRpcConnection | null = null;
  #bulkStatus: ExecutorBulkStatus = { availability: 'offline', lastError: null };
  #bulkActivated = false;
  readonly #bulkListeners = new Set<(status: ExecutorBulkStatus) => void>();
  #latest: RemoteSessionBacking | null = null;
  #candidate: SessionTransport | null = null;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  readonly #waiters = new Set<SessionWaiter>();
  readonly #parked = { primary: new ParkedRpcCalls(), bulk: new ParkedRpcCalls() };
  readonly #admission = new RpcAdmissionBudgets();
  #bulkReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  readonly #reconnectGraceMs: number;
  readonly #log: Logger;
  readonly #sessions: Omit<RemoteSessions, 'call'> = {
    latest: () => this.#latestSession(),
    acquire: (lane, options) => this.#acquire(lane, options),
    send: (lane, options, send) => this.#send(lane, options, send),
  };

  constructor(
    readonly id: string,
    private readonly link: WebSocketLink,
    setupRpc: (rpc: ExecutorRpc) => void = () => {},
    private readonly reportError: (message: string) => void = () => {},
    private readonly options: RemoteExecutorClientOptions = {},
  ) {
    this.#reconnectGraceMs = options.reconnectGraceMs ?? EXECUTOR_RECONNECT_GRACE_MS;
    this.#log = options.logger ?? createLogger('executors');
    this.#unsubscribe = link.onSession((transport) => {
      if (this.#candidateGeneration !== this.#generation) this.#candidateGeneration?.retire();
      this.#candidateGeneration = null;
      this.#candidateBacking = null;
      this.#candidate = transport;
      const connection = new ExecutorRpcConnection(link, transport, {
        parked: this.#parked, admission: this.#admission,
        bulkFailed: (failure) => {
          if (Number.isInteger(Math.log2(failure.retries + 1))) this.#log.warn('Executor bulk setup or recovery failed', { executorId: this.id, ...failure });
        },
      });
      this.#connection = connection;
      const rpc = connection.primary;
      connection.onEndpoint(setupRpc);
      connection.onBulkChanged((status) => {
        if (this.#connection === connection) this.#changeBulk(status);
      });
      transport.onFailure(() => {
        rpc.retireUnknown();
        if (this.#availability === 'disposed' || this.#candidate !== transport) return;
        this.#generation?.terminals.disconnect();
        this.#current = null;
        this.#bulkCurrent = null;
        // A candidate that fails while already reconnecting keeps the original deadline.
        if (this.#availability === 'ready') this.#beginReconnecting();
      });
      const setup = { stage: 'describe' as SessionSetupStage };
      void this.#install(transport, connection, setup).catch((error: unknown) => {
        if (this.#candidate === transport && this.#availability !== 'disposed') {
          // A session that fails during setup rejects the pending call with a generic loss,
          // so the session's own reason is the one worth reporting.
          this.#log.warn('Executor session setup failed', {
            executorId: this.id, stage: setup.stage, reason: failureReason(transport.channel.failure ?? error),
            lane: 'primary', primarySessionId: transport.id, sessionId: transport.id,
            queues: transport.channel.queueSnapshot, ...connection.diagnostics,
          });
          this.reportError(error instanceof ExecutorConfigurationError ? error.message
            : 'Executor initialization failed; check worker configuration and protocol support');
        }
        transport.close(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  get availability(): ExecutorAvailability { return this.#availability; }
  get bulkStatus(): ExecutorBulkStatus { return this.#bulkStatus; }
  get diagnostics() { return this.#connection?.diagnostics ?? null; }
  get generation(): RemoteExecutorGeneration | null { return this.#generation; }
  get runtime() {
    this.#latestSession();
    return this.#generation!.runtime;
  }

  onBulkChanged(listener: (status: ExecutorBulkStatus) => void): () => void {
    this.#bulkListeners.add(listener);
    return () => { this.#bulkListeners.delete(listener); };
  }

  assertIntegrationOrigin(rpc: ExecutorRpc, integrationId: string): void {
    const backing = this.#candidateBacking ?? this.#generation;
    const candidate = this.#candidate;
    const transport = rpc.transport;
    const generation = this.#candidateBacking ? this.#candidateGeneration : this.#generation;
    if (!backing || !candidate || this.#candidateRetired(candidate) || !transport.connected
      || transport.primarySessionId !== candidate.id || !sameContinuity(transport.continuity, backing.continuity)
      || !generation || generation.token.retired || !backing.manifests.has(integrationId)) {
      throw new AgentCallError('rejected', 'Operation is not permitted from this executor generation');
    }
  }

  onAvailabilityChanged(listener: (value: ExecutorAvailability) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  async dispose(): Promise<void> {
    if (this.#availability === 'disposed') return;
    this.#clearReconnectTimer();
    this.#setAvailability('disposed');
    this.#unsubscribe();
    this.#generation?.retire();
    this.#candidateGeneration?.retire();
    this.#workerInventories.clear();
    this.#instanceRuntimes.clear();
    this.#current = null;
    this.#bulkCurrent = null;
    this.#clearBulkReconnectTimer();
    this.#parked.primary.close();
    this.#parked.bulk.close();
    await this.link.dispose();
    this.#listeners.clear();
    this.#bulkListeners.clear();
  }

  async #install(transport: SessionTransport, connection: ExecutorRpcConnection, setup: { stage: SessionSetupStage }): Promise<void> {
    const rpc = connection.primary;
    const assertCandidate = () => {
      if (this.#candidateRetired(transport)) throw new Error('Executor candidate session retired');
    };
    await transport.ready;
    assertCandidate();
    const { info, integrations } = await rpc.call('', 'executor.describe', null);
    assertCandidate();
    if (info.executorId !== this.id || transport.executorId !== this.id) throw new ExecutorConfigurationError(`Executor identity mismatch: worker serves ${info.executorId}; restart the worker to serve ${this.id}`);
    if (typeof info.instanceId !== 'string' || !info.instanceId || !Array.isArray(info.integrationIds)
      || !info.integrationIds.every(id => typeof id === 'string') || new Set(info.integrationIds).size !== info.integrationIds.length
      || !Array.isArray(integrations)) throw new ExecutorConfigurationError('Executor inventory is invalid');
    if (typeof info.projectBasePath !== 'string' || !info.projectBasePath) throw new ExecutorConfigurationError('Executor project base is missing');
    if (!info.services || (['files', 'git', 'gh', 'terminals', 'directoryCreation'] as const).some(key => typeof info.services[key] !== 'boolean')) throw new ExecutorConfigurationError('Executor service capabilities are invalid');
    const previous = this.#generation;
    const sameInstance = previous?.info.instanceId === info.instanceId;
    const workerRuntimeId = transport.continuity.workerRuntimeId;
    const known = this.#workerInventories.get(workerRuntimeId);
    const knownRuntime = this.#instanceRuntimes.get(info.instanceId);
    if (known && known.instanceId !== info.instanceId || knownRuntime !== undefined && knownRuntime !== workerRuntimeId) {
      throw new ExecutorConfigurationError('Executor runtime and instance identity disagree');
    }
    if (previous && !sameInstance) this.#retireGeneration();
    const manifests = new Map<string, IntegrationManifest>();
    for (const manifest of integrations) {
      validateManifest(manifest);
      if (manifest.scope.executorId !== info.executorId || manifest.scope.instanceId !== info.instanceId
        || manifests.has(manifest.descriptor.id)) {
        throw new ExecutorConfigurationError('Executor integration scope mismatch');
      }
      manifests.set(manifest.descriptor.id, freezeInventory(manifest));
    }
    if (manifests.size !== info.integrationIds.length || info.integrationIds.some((id) => !manifests.has(id))) {
      throw new ExecutorConfigurationError('Executor integration inventory mismatch');
    }
    const backing: RemoteSessionBacking = { rpc, info: freezeInventory(info), manifests, continuity: transport.continuity };
    const fingerprint = createHash('sha256').update(stableJsonStringify({
      info, manifests: Object.fromEntries(manifests), continuity: backing.continuity,
    })).digest('hex');
    if (known && known.fingerprint !== fingerprint) {
      throw new ExecutorConfigurationError('Executor inventory or protocol changed within one worker instance');
    }
    this.#workerInventories.set(workerRuntimeId, { instanceId: info.instanceId, fingerprint });
    this.#instanceRuntimes.set(info.instanceId, workerRuntimeId);
    const reconnect = previous && sameInstance && !previous.token.retired;
    const generation = reconnect ? previous : new RemoteExecutorGeneration(backing, this.#sessions, () => this.dispose(), this.#log);
    this.#candidateGeneration = generation;
    this.#candidateBacking = backing;
    rpc.guardDispatch(() => generation.token.assertDispatch());
    try {
      const publish = this.options.prepareGeneration?.(generation);
      setup.stage = 'start-integrations';
      if (!reconnect) for (const integration of generation.integrations.values()) {
        await integration.initialize(backing, assertCandidate);
        assertCandidate();
      }
      rpc.onTerminal(frame => generation.terminals.receive(frame, rpc));
      rpc.onProducer(({ notification, seq }) => {
        if (generation.token.retired) return;
        const integration = generation.integrations.get(notification.binding.integrationId);
        if (!integration) throw new Error('Unknown producer integration');
        integration.receive(notification, seq, backing);
      });
      setup.stage = 'resume-bindings';
      const reconciling = rpc.reconcileParked();
      reconciling.catch(() => undefined);
      if (reconnect) for (const integration of generation.integrations.values()) {
        await integration.resume(backing);
        assertCandidate();
      }
      await reconciling;
      assertCandidate();
      setup.stage = 'activate';
      this.#current = backing;
      this.#latest = backing;
      this.#generation = generation;
      publish?.();
      connection.activate();
      assertCandidate();
      this.#clearReconnectTimer();
      this.#resolveWaiters('primary', backing);
      this.#setAvailability('ready');
    } catch (error) {
      if (!reconnect) {
        generation.retire();
        if (this.#candidate === transport && this.#generation === generation) this.#abandonBindings();
      }
      throw error;
    }
  }

  #changeBulk(status: BulkConnectionStatus): void {
    const previous = this.#bulkCurrent;
    this.#bulkCurrent = null;
    if (status.phase === 'ready' && this.#current && this.#connection?.bulk.current) {
      this.#bulkCurrent = { ...this.#current, rpc: this.#connection.bulk.current };
      const generation = this.#generation!;
      this.#bulkCurrent.rpc.guardDispatch(() => generation.token.assertDispatch());
      this.#clearBulkReconnectTimer();
      this.#resolveWaiters('bulk', this.#bulkCurrent);
    } else if (previous && !this.#bulkReconnectTimer && this.#availability !== 'disposed') {
      this.#bulkReconnectTimer = setTimeout(() => {
        this.#bulkReconnectTimer = null;
        this.link.fenceBulk();
        this.#parked.bulk.rejectAll();
      }, this.#reconnectGraceMs);
      this.#bulkReconnectTimer.unref?.();
    }
    let availability: ExecutorBulkStatus['availability'];
    if (status.phase === 'ready') {
      this.#bulkActivated = true;
      availability = 'ready';
    } else if (status.phase === 'offline') availability = 'offline';
    else availability = this.#bulkActivated ? 'reconnecting' : 'connecting';
    let lastError = this.#bulkStatus.lastError;
    if (availability === 'ready') lastError = null;
    else if (status.error) lastError = { code: 'EXECUTOR_BULK_UNAVAILABLE', message: failureReason(status.error) };
    const snapshot = { availability, lastError };
    if (isDeepStrictEqual(snapshot, this.#bulkStatus)) return;
    this.#bulkStatus = snapshot;
    for (const listener of this.#bulkListeners) listener(snapshot);
  }

  #resolveWaiters(lane: RpcLane, backing: RemoteSessionBacking): void {
    for (const waiter of [...this.#waiters]) if (waiter.lane === lane) waiter.resolve(backing);
  }

  #clearBulkReconnectTimer(): void {
    if (this.#bulkReconnectTimer) clearTimeout(this.#bulkReconnectTimer);
    this.#bulkReconnectTimer = null;
  }

  #candidateRetired(transport: SessionTransport): boolean {
    return this.#candidate !== transport || this.#availability === 'disposed' || !transport.connected;
  }

  #beginReconnecting(): void {
    this.#setAvailability('reconnecting');
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      if (this.#availability === 'reconnecting') this.#abandonBindings();
    }, this.#reconnectGraceMs);
    this.#reconnectTimer.unref?.();
  }

  // Publishes `offline` so active runs on this executor fail as disconnected.
  #abandonBindings(): void {
    this.#clearReconnectTimer();
    this.#generation?.abandonBindings();
    this.#parked.primary.rejectAll();
    this.#parked.bulk.rejectAll();
    this.#clearBulkReconnectTimer();
    this.#setAvailability('offline');
  }

  #retireGeneration(): void {
    this.#generation?.retire();
    for (const waiter of [...this.#waiters]) waiter.reject(staleGeneration());
    this.#current = null;
    this.#bulkCurrent = null;
    this.#abandonBindings();
  }

  #clearReconnectTimer(): void {
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
  }

  #latestSession(): RemoteSessionBacking {
    if (!this.#latest || !this.#holdsCalls()) throw new AgentCallError('not-dispatched', `Executor is ${this.#availability}`);
    return this.#latest;
  }

  // A session that has just failed may still read as ready until its failure
  // listener marks the executor reconnecting.
  #holdsCalls(): boolean {
    return Boolean(this.#generation && !this.#generation.token.retired
      && (this.#availability === 'ready' || this.#availability === 'reconnecting'));
  }

  async #acquire(lane: RpcLane, options: HeldCallOptions = {}): Promise<HeldSession> {
    const session = await this.#holdSession(lane, options);
    if (options.instanceId !== undefined && session.backing.info.instanceId !== options.instanceId) {
      throw staleGeneration();
    }
    return session;
  }

  async #holdSession(lane: RpcLane, options: HeldCallOptions): Promise<HeldSession> {
    const timeoutMs = options.timeoutMs === undefined ? DEFAULT_RPC_TIMEOUT_MS : options.timeoutMs;
    if (options.signal?.aborted) throw heldCallCancelled();
    const current = lane === 'primary' ? this.#current : this.#bulkCurrent;
    if (current?.rpc.active) return { backing: current, timeoutMs };
    if (!this.#latest || !this.#holdsCalls()) throw new AgentCallError('not-dispatched', `Executor is ${this.#availability}`);
    const dispatchWaitMs = options.dispatchDeadline === undefined ? null : options.dispatchDeadline - performance.now();
    if (dispatchWaitMs !== null && dispatchWaitMs <= 0) throw reconnectTimedOut();
    const reserved = timeoutMs === null ? 0 : Math.min(HELD_CALL_BUDGET_MS, Math.floor(timeoutMs / 2));
    const waitMs = Math.min(timeoutMs === null ? Infinity : timeoutMs - reserved,
      dispatchWaitMs ?? Infinity, lane === 'bulk' ? BULK_ACQUIRE_TIMEOUT_MS : Infinity);
    const started = performance.now();
    const release = this.#admission.outgoing.acquire(lane);
    try {
      const backing = await this.#nextSession(lane, options.signal, Number.isFinite(waitMs) ? waitMs : null);
      return { backing, timeoutMs: timeoutMs === null ? null : Math.max(reserved, Math.ceil(timeoutMs - (performance.now() - started))) };
    } finally { release(); }
  }

  async #send<T>(lane: RpcLane, options: HeldCallOptions = {}, send: (session: HeldSession) => Promise<T>): Promise<T> {
    const timeoutMs = options.timeoutMs === undefined ? DEFAULT_RPC_TIMEOUT_MS : options.timeoutMs;
    const started = performance.now();
    const dispatchDeadline = lane === 'bulk'
      ? Math.min(options.dispatchDeadline ?? Infinity, started + BULK_ACQUIRE_TIMEOUT_MS)
      : options.dispatchDeadline;
    let held = { ...options, dispatchDeadline };
    for (let previous: RemoteSessionBacking | null = null; ;) {
      const session = await this.#acquire(lane, held);
      try {
        return await send(session);
      } catch (error) {
        const remaining = timeoutMs === null ? null : Math.ceil(timeoutMs - (performance.now() - started));
        const unsent = error instanceof ExecutorSessionLostError && error.outcome === 'not-dispatched';
        if (!unsent || session.backing === previous || (remaining !== null && remaining < 1)) throw error;
        previous = session.backing;
        held = { ...options, dispatchDeadline, timeoutMs: remaining, instanceId: session.backing.info.instanceId };
      }
    }
  }

  #nextSession(lane: RpcLane, signal: AbortSignal | undefined, timeoutMs: number | null): Promise<RemoteSessionBacking> {
    const next = Promise.withResolvers<RemoteSessionBacking>();
    const finish = () => {
      this.#waiters.delete(waiter);
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    };
    const waiter: SessionWaiter = {
      lane,
      resolve: (backing) => { finish(); next.resolve(backing); },
      reject: (error) => { finish(); next.reject(error); },
    };
    const cancel = () => waiter.reject(heldCallCancelled());
    const timer = timeoutMs === null ? null : setTimeout(() => waiter.reject(reconnectTimedOut()), timeoutMs);
    timer?.unref?.();
    signal?.addEventListener('abort', cancel, { once: true });
    this.#waiters.add(waiter);
    return next.promise;
  }

  #setAvailability(value: ExecutorAvailability): void {
    if (this.#availability === value) return;
    this.#availability = value;
    this.#generation?.setAvailability(value);
    if (value === 'offline' || value === 'disposed') {
      for (const waiter of [...this.#waiters]) waiter.reject(new AgentCallError('not-dispatched', `Executor is ${value}`));
    }
    for (const listener of this.#listeners) listener(value);
  }
}

function heldCallCancelled(): AgentCallError {
  return new AgentCallError('not-dispatched', 'The request was cancelled while the executor reconnected.');
}
