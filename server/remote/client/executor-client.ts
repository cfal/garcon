import { isDeepStrictEqual } from 'node:util';
import {
  AgentCallError,
  type ExecutionRuntimeApi,
  type ExecutorInfo,
  type ExecutionProjectService,
  type ExecutorAvailability,
  type ExecutorCallOptions,
  type ApiProviderDiscoveryRequest,
} from '@garcon/server-agent-interface';
import { RemoteAgentIntegration } from './remote-agent-integration.js';
import { DEFAULT_RPC_TIMEOUT_MS, ExecutorRpc, ParkedRpcCalls, type RpcCallOptions } from '../transport/rpc.js';
import type { ExecutorRpcMethods, IntegrationManifest } from '../transport/rpc-protocol.js';
import type { SessionTransport } from '../transport/session-transport.js';
import type { WebSocketLink } from '../transport/websocket-link.js';
import { failureReason } from '../transport/failure-reason.js';
import { createLogger, type Logger } from '../../common/log.js';
import { unavailableService } from '../../common/unavailable-service.js';
import { MODEL_DISCOVERY_TIMEOUT_MS } from '../../common/provider-discovery.js';
import { RemoteFilesService } from './remote-files.js';
import { RemoteGitServices } from './remote-git.js';
import { RemoteTerminalService } from './remote-terminals.js';
import { parseTicketProjectDefault } from '../../../common/ticket-responses.js';

export interface RemoteSessionBacking {
  readonly rpc: ExecutorRpc;
  readonly info: ExecutorInfo;
  readonly manifests: ReadonlyMap<string, IntegrationManifest>;
}

export interface RemoteExecutorInventory {
  readonly integrations: readonly IntegrationManifest[];
}

// `timeoutMs` bounds both the wait and the call, as in `ExecutorRpc.call`:
// omitted, it is that call's default; null waits without a deadline.
export interface HeldCallOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number | null;
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
  acquire(options?: HeldCallOptions): Promise<HeldSession>;
  call<K extends keyof ExecutorRpcMethods>(
    integrationId: string, method: K, request: ExecutorRpcMethods[K]['request'],
    options?: RpcCallOptions<ExecutorRpcMethods[K]['result']>,
  ): Promise<ExecutorRpcMethods[K]['result']>;
}

interface SessionWaiter {
  resolve(backing: RemoteSessionBacking): void;
  reject(error: Error): void;
}

class ExecutorConfigurationError extends Error {}

// Matches the worker relay's grace. Within it, a replacement session resumes
// transcript bindings; after it, active runs fail as disconnected.
const EXECUTOR_RECONNECT_GRACE_MS = 3 * 60 * 60 * 1000;
// A held call keeps up to this much of its deadline for the call itself, so it is
// not dispatched just before timing out with an unknown outcome.
const HELD_CALL_BUDGET_MS = 1_000;

export interface RemoteExecutorClientOptions {
  readonly reconnectGraceMs?: number;
  readonly logger?: Logger;
}

// How far a session's setup got, logged when it fails.
type SessionSetupStage = 'describe' | 'start-integrations' | 'resume-bindings' | 'activate';

export class RemoteExecutorClient implements ExecutionRuntimeApi {
  readonly #integrations = new Map<string, RemoteAgentIntegration>();
  readonly #listeners = new Set<(value: ExecutorAvailability) => void>();
  readonly #unsubscribe: () => void;
  #availability: ExecutorAvailability = 'offline';
  #current: RemoteSessionBacking | null = null;
  #latest: RemoteSessionBacking | null = null;
  #candidate: SessionTransport | null = null;
  #initialized = false;
  #instanceId: string | null = null;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  readonly #waiters = new Set<SessionWaiter>();
  readonly #parked = new ParkedRpcCalls();
  readonly #reconnectGraceMs: number;
  readonly #log: Logger;
  readonly #sessions: RemoteSessions = {
    latest: () => this.#latestSession(),
    acquire: (options) => this.#acquire(options),
    call: async (integrationId, method, request, options) => {
      const { backing, timeoutMs } = await this.#acquire(options);
      return backing.rpc.call(integrationId, method, request, { ...options, timeoutMs });
    },
  };
  readonly #files = new RemoteFilesService(this.#sessions);
  readonly #git = new RemoteGitServices(this.#sessions);
  readonly #terminals = new RemoteTerminalService(this.#sessions);
  readonly #projects: ExecutionProjectService = {
    ticketProjectDefault: async (request, options) => parseTicketProjectDefault(await this.#sessions.call('', 'projects.ticketProjectDefault', request, options)),
    inspect: (request, options) => this.#sessions.call('', 'projects.inspect', request, options),
    resolveFileMentions: (request, options) => this.#sessions.call('', 'projects.resolveFileMentions', request, options),
  };

  constructor(
    readonly id: string,
    private readonly link: WebSocketLink,
    setupRpc: (rpc: ExecutorRpc) => void = () => {},
    private readonly reportError: (message: string) => void = () => {},
    private readonly expectedInventory: RemoteExecutorInventory | null = null,
    options: RemoteExecutorClientOptions = {},
  ) {
    this.#reconnectGraceMs = options.reconnectGraceMs ?? EXECUTOR_RECONNECT_GRACE_MS;
    this.#log = options.logger ?? createLogger('executors');
    this.#unsubscribe = link.onSession((transport) => {
      this.#candidate = transport;
      const rpc = new ExecutorRpc(transport, { parked: this.#parked });
      rpc.onTerminal((frame) => this.#terminals.receive(frame, rpc));
      setupRpc(rpc);
      transport.onFailure(() => {
        rpc.retireUnknown();
        if (this.#availability === 'disposed' || this.#candidate !== transport) return;
        this.#terminals.disconnect();
        this.#current = null;
        // A candidate that fails while already reconnecting keeps the original deadline.
        if (this.#availability === 'ready') this.#beginReconnecting();
      });
      const setup = { stage: 'describe' as SessionSetupStage };
      void this.#install(transport, rpc, setup).catch((error: unknown) => {
        if (this.#candidate === transport && this.#availability !== 'disposed') {
          // A session that fails during setup rejects the pending call with a generic loss,
          // so the session's own reason is the one worth reporting.
          this.#log.warn('Executor session setup failed', {
            executorId: this.id, stage: setup.stage, reason: failureReason(transport.channel.failure ?? error),
          });
          this.reportError(error instanceof ExecutorConfigurationError ? error.message
            : 'Executor initialization failed; check worker configuration and matching builds');
        }
        transport.close(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  get availability(): ExecutorAvailability { return this.#availability; }

  get inventory(): RemoteExecutorInventory | null {
    return !this.#initialized ? null : {
      integrations: [...this.#integrations.values()].map((integration) => integration.manifest),
    };
  }

  async getInfo(options?: ExecutorCallOptions): Promise<ExecutorInfo> {
    options?.signal?.throwIfAborted();
    return this.#latestSession().info;
  }

  async getAgentIntegration(agentId: string, options?: ExecutorCallOptions) {
    options?.signal?.throwIfAborted();
    this.#latestSession();
    const integration = this.#integrations.get(agentId);
    if (!integration) throw new AgentCallError('not-dispatched', 'Integration is unavailable on this executor', 'OPERATION_UNSUPPORTED');
    return integration;
  }

  async discoverApiProviderModels(request: ApiProviderDiscoveryRequest, options?: ExecutorCallOptions) {
    return this.#sessions.call('', 'apiProviders.discoverModels', request, {
      ...options, timeoutMs: options?.timeoutMs ?? MODEL_DISCOVERY_TIMEOUT_MS + 5_000,
    });
  }
  async getProjectService(options?: ExecutorCallOptions): Promise<ExecutionProjectService> {
    options?.signal?.throwIfAborted();
    this.#latestSession();
    return this.#projects;
  }
  async getFilesService(options?: ExecutorCallOptions) {
    options?.signal?.throwIfAborted();
    if (!this.#latestSession().info.services.files) throw unavailableService('files');
    return this.#files;
  }
  async getGitService(options?: ExecutorCallOptions) {
    options?.signal?.throwIfAborted();
    if (!this.#latestSession().info.services.git) throw unavailableService('git');
    return this.#git.git;
  }
  async getGhService(options?: ExecutorCallOptions) {
    options?.signal?.throwIfAborted();
    if (!this.#latestSession().info.services.gh) throw unavailableService('gh');
    return this.#git.gh;
  }
  async getTerminalService(options?: ExecutorCallOptions) {
    options?.signal?.throwIfAborted();
    if (!this.#latestSession().info.services.terminals) throw unavailableService('terminals');
    return this.#terminals;
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
    this.#terminals.disconnect();
    this.#current = null;
    this.#parked.close();
    for (const integration of this.#integrations.values()) integration.retire();
    await this.link.dispose();
    this.#listeners.clear();
  }

  async #install(transport: SessionTransport, rpc: ExecutorRpc, setup: { stage: SessionSetupStage }): Promise<void> {
    await transport.ready;
    const { info, integrations } = await rpc.call('', 'executor.describe', null);
    if (info.executorId !== this.id || transport.executorId !== this.id) throw new ExecutorConfigurationError(`Executor identity mismatch: worker serves ${info.executorId}; restart the worker to serve ${this.id}`);
    if (typeof info.projectBasePath !== 'string' || !info.projectBasePath) throw new ExecutorConfigurationError('Executor project base is missing');
    if (!info.services || (['files', 'git', 'gh', 'terminals'] as const).some(key => typeof info.services[key] !== 'boolean')) throw new ExecutorConfigurationError('Executor machine capabilities are invalid');
    const manifests = new Map<string, IntegrationManifest>();
    for (const manifest of integrations) {
      if (manifest.scope.executorId !== info.executorId || manifest.scope.instanceId !== info.instanceId
        || manifest.scope.integrationId !== manifest.descriptor.id || manifests.has(manifest.descriptor.id)) {
        throw new ExecutorConfigurationError('Executor integration scope mismatch');
      }
      manifests.set(manifest.descriptor.id, manifest);
    }
    if (manifests.size !== info.integrationIds.length || info.integrationIds.some((id) => !manifests.has(id))) {
      throw new ExecutorConfigurationError('Executor integration inventory mismatch');
    }
    if (this.expectedInventory) {
      if (manifests.size !== this.expectedInventory.integrations.length
        || this.expectedInventory.integrations.some(({ scope: _scope, ...expected }) => {
          const { scope: _replacementScope, ...replacement } = manifests.get(expected.descriptor.id) ?? {};
          return !isDeepStrictEqual(expected, replacement);
        })) throw new ExecutorConfigurationError('Executor provider inventory changed; restart the controller to accept it');
    }
    const backing: RemoteSessionBacking = { rpc, info, manifests };
    const initial = !this.#initialized;
    // A restarted worker holds none of the previous bindings or native turns.
    if (this.#instanceId !== null && this.#instanceId !== info.instanceId && this.#availability === 'reconnecting') {
      this.#abandonBindings();
    }
    const candidates = initial ? new Map([...manifests.values()].map((manifest) => [
      manifest.descriptor.id, new RemoteAgentIntegration(manifest, this.#sessions, this.#log),
    ])) : this.#integrations;
    if (!initial) {
      if (this.#integrations.size !== manifests.size) throw new ExecutorConfigurationError('Executor provider inventory changed; restart the controller to accept it');
      for (const [id, integration] of this.#integrations) {
        const { scope: _oldScope, ...previous } = integration.manifest;
        const { scope: _newScope, ...replacement } = manifests.get(id) ?? {};
        if (!isDeepStrictEqual(previous, replacement)) throw new ExecutorConfigurationError('Executor provider capabilities changed; restart the controller to accept them');
      }
    }
    setup.stage = 'start-integrations';
    for (const integration of candidates.values()) await integration.initializeReplacement(backing, initial);
    if (this.#candidateRetired(transport)) throw new Error('Executor candidate session retired');
    if (initial) {
      for (const [id, integration] of candidates) this.#integrations.set(id, integration);
      this.#initialized = true;
    }
    rpc.onProducer(({ notification, seq }) => {
      const integration = this.#integrations.get(notification.binding.integrationId);
      if (!integration) throw new Error('Unknown producer integration');
      integration.receive(notification, seq, backing);
    });
    setup.stage = 'resume-bindings';
    // Sent ahead of producer resumption, whose replay can fill the session queue.
    const reconciling = rpc.reconcileParked();
    reconciling.catch(() => undefined);
    for (const integration of this.#integrations.values()) await integration.resume(backing);
    await reconciling;
    if (this.#candidateRetired(transport)) throw new Error('Executor candidate session retired');
    setup.stage = 'activate';
    this.#instanceId = info.instanceId;
    this.#clearReconnectTimer();
    this.#current = backing;
    this.#latest = backing;
    this.#setAvailability('ready');
    for (const waiter of [...this.#waiters]) waiter.resolve(backing);
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
    for (const integration of this.#integrations.values()) integration.retire();
    this.#parked.rejectAll();
    this.#setAvailability('offline');
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
    return this.#availability === 'ready' || this.#availability === 'reconnecting';
  }

  async #acquire(options: HeldCallOptions = {}): Promise<HeldSession> {
    const timeoutMs = options.timeoutMs === undefined ? DEFAULT_RPC_TIMEOUT_MS : options.timeoutMs;
    if (this.#current?.rpc.transport.connected) return { backing: this.#current, timeoutMs };
    if (!this.#latest || !this.#holdsCalls()) throw new AgentCallError('not-dispatched', `Executor is ${this.#availability}`);
    if (options.signal?.aborted) throw heldCallCancelled();
    if (timeoutMs === null) return { backing: await this.#nextSession(options.signal, null), timeoutMs };
    const reserved = Math.min(HELD_CALL_BUDGET_MS, Math.floor(timeoutMs / 2));
    const started = performance.now();
    const backing = await this.#nextSession(options.signal, timeoutMs - reserved);
    return { backing, timeoutMs: Math.max(reserved, Math.ceil(timeoutMs - (performance.now() - started))) };
  }

  #nextSession(signal: AbortSignal | undefined, timeoutMs: number | null): Promise<RemoteSessionBacking> {
    const next = Promise.withResolvers<RemoteSessionBacking>();
    const finish = () => {
      this.#waiters.delete(waiter);
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    };
    const waiter: SessionWaiter = {
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
    if (value === 'offline' || value === 'disposed') {
      for (const waiter of [...this.#waiters]) waiter.reject(new AgentCallError('not-dispatched', `Executor is ${value}`));
    }
    for (const listener of this.#listeners) listener(value);
  }
}

function heldCallCancelled(): AgentCallError {
  return new AgentCallError('not-dispatched', 'The request was cancelled while the executor reconnected.');
}

function reconnectTimedOut(): AgentCallError {
  return new AgentCallError('not-dispatched', 'The executor did not reconnect in time.');
}
