import {
  AgentCallError, type AgentIntegration, type ExecutionRuntimeApi, type ExecutorInfo,
  type ExecutionProjectService, type ExecutorAvailability, type ExecutorCallOptions,
} from '@garcon/server-agent-interface';
import {
  effectiveExecutorId, LOCAL_EXECUTOR_ID, LOCAL_EXECUTOR_LABEL, type AgentExecutionTarget,
  type CreateExecutorRequest, type ExecutorSnapshot, type ExecutorSnapshotAvailability, type UpdateExecutorRequest,
} from '../../../common/executors.js';
import { IntegrationRegistry } from '../../runtime/agents/integration-registry.js';
import { DomainError } from '../../common/domain-error.js';
import { createLogger, type Logger } from '../../common/log.js';
import { ExecutorConfigStore, type RemoteExecutorConfig } from './config-store.js';
import { ExecutionRuntime } from '../../runtime/execution-runtime.js';
import { RemoteExecutorClient, type RemoteExecutorInventory } from '../../remote/client/executor-client.js';
import { shouldLogLinkFailure, WebSocketLink } from '../../remote/transport/websocket-link.js';
import { ExecutorSocketAdmission } from '../../remote/transport/socket-admission.js';
import { ExecutorReferenceWrites } from './reference-writes.js';
import type { ControllerCliDispatcher } from './cli-dispatcher.js';

type LocalExecutorOptions = ConstructorParameters<typeof ExecutionRuntime>[0];

// Clients learn of an executor's link failures at most this often, so a peer
// that keeps failing, however its failures alternate, cannot flood them.
const LINK_FAILURE_NOTICE_MS = 1_000;

interface ManagedRemote {
  config: RemoteExecutorConfig;
  executor: RemoteExecutorClient | null;
  link: WebSocketLink | null;
  integrations: IntegrationRegistry | null;
  knownIntegrations: IntegrationRegistry | null;
  inventory: RemoteExecutorInventory | null;
  info: ExecutorInfo | null;
  error: ExecutorSnapshot['lastError'];
  preparation: object | null;
  cliLease: AbortController;
}

export class ExecutorManager {
  readonly #remotes = new Map<string, ManagedRemote>();
  readonly #socketAdmission = new ExecutorSocketAdmission();
  readonly #changes = new Set<() => void>();
  readonly #availability = new Set<(executorId: string, value: ExecutorAvailability) => void>();
  readonly #changing = new Set<string>();
  readonly #referenceWrites = new ExecutorReferenceWrites((executorId) => {
    if (this.#disposed || this.#quiescing || this.#changing.has(executorId)) {
      throw new DomainError('EXECUTOR_IN_USE', 'This executor is being changed. Try saving again after the change finishes.', 409, true);
    }
    this.config.require(executorId);
  });
  readonly retainReferences = this.#referenceWrites.retain;
  #mutations: Promise<unknown> = Promise.resolve();
  #disposed = false;
  #quiescing = false;
  #cliDispatcher: ControllerCliDispatcher | null = null;
  #guards = { assertIdle: (_id: string) => {}, assertRemovable: (_id: string) => {} };

  private constructor(
    readonly local: ExecutionRuntime,
    readonly localIntegrations: IntegrationRegistry,
    readonly localInfo: ExecutorInfo,
    readonly config: ExecutorConfigStore,
    private readonly options: LocalExecutorOptions,
    private readonly logger: Logger,
  ) {}

  static async create(options: LocalExecutorOptions, logger: Logger = createLogger('executors')): Promise<ExecutorManager> {
    const config = new ExecutorConfigStore(options.workspaceDir);
    await config.initialize();
    const local = new ExecutionRuntime({ ...options, id: LOCAL_EXECUTOR_ID });
    try {
      const info = await local.getInfo();
      const integrations = new IntegrationRegistry({ instances: await Promise.all(info.integrationIds.map((id) => local.getAgentIntegration(id))) });
      const manager = new ExecutorManager(local, integrations, info, config, options, logger);
      await manager.#applyConfig();
      return manager;
    } catch (error) { await local.dispose(); throw error; }
  }

  setGuards(guards: { assertIdle(executorId: string): void; assertRemovable(executorId: string): void }): void {
    this.#guards = guards;
  }

  setCliDispatcher(dispatcher: ControllerCliDispatcher): void { this.#cliDispatcher = dispatcher; }

  isReady(executorId: string): boolean {
    if (this.#disposed || this.#changing.has(executorId)) return false;
    if (executorId === LOCAL_EXECUTOR_ID) return this.local.availability === 'ready';
    const entry = this.#remotes.get(executorId);
    return Boolean(entry?.config.enabled && !entry.preparation && entry.integrations && entry.executor?.availability === 'ready');
  }

  isReconnecting(executorId: string): boolean {
    return !this.#disposed && this.#remotes.get(executorId)?.executor?.availability === 'reconnecting';
  }

  // Also returns a remote executor that is reconnecting to a worker whose
  // integrations are known; its calls wait for the replacement session within
  // their own deadlines.
  requireExecutor(executorId: string): ExecutionRuntimeApi {
    if (!this.isReady(executorId) && !this.#holdsCalls(executorId)) {
      throw new DomainError('EXECUTOR_UNAVAILABLE', 'Executor is unavailable', 503, true);
    }
    return executorId === LOCAL_EXECUTOR_ID ? this.local : this.#remotes.get(executorId)!.executor!;
  }

  integrationsFor(executorId: string): IntegrationRegistry {
    this.requireExecutor(executorId);
    return executorId === LOCAL_EXECUTOR_ID ? this.localIntegrations : this.#remotes.get(executorId)!.integrations!;
  }

  knownIntegration(target: AgentExecutionTarget): AgentIntegration | null {
    return (target.executorId === LOCAL_EXECUTOR_ID ? this.localIntegrations : this.#remotes.get(target.executorId)?.knownIntegrations)?.get(target.agentId) ?? null;
  }

  requireIntegration(target: AgentExecutionTarget): AgentIntegration {
    return this.integrationsFor(target.executorId).require(target.agentId);
  }

  async projectService(executorId: string): Promise<ExecutionProjectService> {
    return this.requireExecutor(executorId).getProjectService();
  }

  inspectProject = async (projectPath: string, executorId?: string | null, options?: ExecutorCallOptions) => (
    (await (await this.projectService(effectiveExecutorId(executorId))).inspect({ projectPath }, options)).resolution
  );

  resolveFileMentions = async (command: string, projectPath: string, executorId?: string | null, options?: ExecutorCallOptions): Promise<string> => (
    (await this.projectService(effectiveExecutorId(executorId))).resolveFileMentions({ command, projectPath }, options)
  );

  list(): readonly ExecutorSnapshot[] {
    return [{
      id: LOCAL_EXECUTOR_ID, label: LOCAL_EXECUTOR_LABEL, kind: 'local', enabled: true, direction: null,
      allowControllerCli: true,
      allowExecutorManagement: true,
      availability: this.#disposed ? 'offline' : 'ready', projectBasePath: this.localInfo.projectBasePath,
      instanceId: this.localInfo.instanceId,
      bulk: null,
      lastError: null, machineServices: { files: true, git: true, gh: true, terminals: true, directoryCreation: this.localInfo.services.directoryCreation },
    }, ...[...this.#remotes.values()].map((entry): ExecutorSnapshot => ({
      id: entry.config.id, label: entry.config.label, kind: 'remote', enabled: entry.config.enabled,
      allowControllerCli: entry.config.allowControllerCli,
      allowExecutorManagement: entry.config.allowExecutorManagement,
      direction: entry.config.connection.kind,
      availability: this.#snapshotAvailability(entry.config.id),
      projectBasePath: entry.info?.projectBasePath ?? null, lastError: entry.error,
      instanceId: entry.info?.instanceId ?? null,
      bulk: entry.executor?.bulkStatus ?? { availability: 'offline', lastError: null },
      machineServices: { files: entry.info?.services.files === true, git: entry.info?.services.git === true, gh: entry.info?.services.gh === true, terminals: entry.info?.services.terminals === true, directoryCreation: entry.info?.services.directoryCreation === true },
    }))];
  }

  inboundLink(executorId: string): WebSocketLink | null {
    const entry = this.#remotes.get(executorId);
    return !this.#disposed && !this.#changing.has(executorId) && entry?.config.enabled
      && entry.config.connection.kind === 'executor-connects' && entry.link?.acceptsSocket ? entry.link : null;
  }

  onChanged(listener: () => void): () => void {
    this.#changes.add(listener);
    return () => { this.#changes.delete(listener); };
  }

  onAvailabilityChanged(listener: (executorId: string, value: ExecutorAvailability) => void): () => void {
    this.#availability.add(listener);
    return () => { this.#availability.delete(listener); };
  }

  create(request: CreateExecutorRequest, options: { publicBase?: string; assertCurrent?: () => void } = {}): Promise<RemoteExecutorConfig> {
    return this.#mutate(async () => this.config.create(request, options.publicBase), options.assertCurrent);
  }

  update(id: string, request: UpdateExecutorRequest, assertCurrent?: () => void): Promise<RemoteExecutorConfig> {
    return this.#mutate((requireIdle) => this.config.update(id, request, (previous, next) => {
      if (!sameConnector(previous, next)) requireIdle(id);
    }), assertCurrent);
  }

  remove(id: string, assertCurrent?: () => void): Promise<void> {
    return this.#mutate(async (requireIdle) => {
      requireIdle(id);
      this.#referenceWrites.assertNoWrites(id);
      this.#guards.assertRemovable(id);
      await this.config.remove(id);
    }, assertCurrent);
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const entry of this.#remotes.values()) entry.cliLease.abort();
    await this.#mutations.catch(() => undefined);
    await Promise.allSettled([...this.#remotes.values()].map((entry) => entry.executor?.dispose()));
    this.#remotes.clear();
    await this.local.dispose();
    this.#changes.clear();
    this.#availability.clear();
  }

  quiesce(): void {
    this.#quiescing = true;
    for (const entry of this.#remotes.values()) { entry.cliLease.abort(); entry.link?.quiesce(); }
  }

  #mutate<T>(operation: (requireIdle: (executorId: string) => void) => Promise<T>, assertCurrent?: () => void): Promise<T> {
    const result = this.#mutations.then(async () => {
      if (this.#disposed || this.#quiescing) throw new DomainError('SERVER_SHUTTING_DOWN', 'Executors are stopping', 503);
      assertCurrent?.();
      let executorId: string | null = null;
      const requireIdle = (id: string) => {
        this.config.require(id);
        this.#guards.assertIdle(id);
        this.#changing.add(id);
        executorId = id;
      };
      try { return await operation(requireIdle); }
      finally {
        try { if (!this.#disposed) await this.#applyConfig(); }
        finally {
          if (executorId !== null) {
            this.#changing.delete(executorId);
            if (this.isReady(executorId)) this.#publishAvailability(executorId, 'ready');
          }
          this.#changed();
        }
      }
    });
    this.#mutations = result.catch(() => undefined);
    return result;
  }

  async #applyConfig(): Promise<void> {
    const executors = this.config.list().map((config) => this.config.isDurable(config.id) ? config : {
      ...config, enabled: false, allowControllerCli: false, allowExecutorManagement: false,
    });
    const previous = new Map(this.#remotes);
    for (const [id, entry] of this.#remotes) {
      const next = executors.find((executor) => executor.id === id);
      if (next && sameConnector(entry.config, next)) {
        if (next.allowControllerCli !== entry.config.allowControllerCli
          || next.allowExecutorManagement !== entry.config.allowExecutorManagement) {
          entry.cliLease.abort();
          entry.cliLease = new AbortController();
        }
        entry.config = next;
        continue;
      }
      entry.cliLease.abort();
      this.#remotes.delete(id);
      await entry.executor?.dispose();
      this.#publishAvailability(id, 'offline');
    }
    for (const config of executors) {
      if (this.#remotes.has(config.id)) continue;
      const known = previous.get(config.id);
      const entry: ManagedRemote = { config, executor: null, link: null, integrations: null,
        knownIntegrations: known?.knownIntegrations ?? null, inventory: known?.inventory ?? null,
        info: known?.info ?? null, error: null, preparation: null, cliLease: new AbortController() };
      this.#remotes.set(config.id, entry);
      if (!this.config.isDurable(config.id)) {
        entry.error = { code: 'EXECUTOR_UNAVAILABLE', message: 'Executor configuration durability is unknown. Restart the controller.' };
      }
      if (!config.enabled) continue;
      // Returns whether the executor's error changed.
      const recordError = (message: string): boolean => {
        if (!this.#current(entry) || entry.error?.message === message) return false;
        entry.error = { code: 'EXECUTOR_UNAVAILABLE', message };
        return true;
      };
      const reportError = (message: string) => { if (recordError(message)) this.#changed(); };
      const noticeLinkFailure = throttledNotice(LINK_FAILURE_NOTICE_MS, () => { if (this.#current(entry)) this.#changed(); });
      const showLinkFailure = (message: string, reason?: string) => {
        if (recordError(reason ? `${message}: ${reason}` : message)) noticeLinkFailure();
      };
      const link = new WebSocketLink({ role: 'controller', executorId: config.id, secret: config.secret,
        noTls: config.noTls, allowUnverifiedTls: config.allowUnverifiedTls, socketAdmission: this.#socketAdmission });
      entry.link = link;
      link.onError((failure) => {
        if (shouldLogLinkFailure(failure)) this.logger.warn('Executor link failed', { executorId: config.id, ...failure });
        // Unidentified inbound sockets cannot explain the loss of an established primary.
        const availability = entry.executor?.availability;
        const unclassifiedOffline = failure.lane === undefined && availability === 'offline' && link.current === null;
        if (availability !== 'ready' && (failure.lane === 'primary' || unclassifiedOffline)) showLinkFailure(failure.message, failure.reason);
      });
      link.onClosure((closure) => {
        this.logger.warn('Executor link closed', { executorId: config.id, ...closure, ...entry.executor?.diagnostics });
        // Only the connection carrying the session reports a closure, so this is the
        // executor's own loss, unless setup retired the session after reporting why.
        if (closure.lane === 'bulk' || closure.cause === 'local-close' || (closure.cause === 'session-retired' && entry.error !== null)) return;
        showLinkFailure('Executor connection lost', closure.reason);
      });
      entry.executor = new RemoteExecutorClient(config.id, link, (rpc) => rpc.handle(async (call, signal, guardReply) => {
        if (call.method === 'controllerCli.describe' || call.method === 'controllerCli.request') {
          const lease = entry.cliLease;
          const assertCurrent = () => {
            const currentLane = rpc.transport.lane === 'primary' ? entry.link?.current : entry.link?.bulk;
            if (!this.#current(entry) || this.#quiescing || currentLane !== rpc.transport
              || entry.link?.current?.id !== rpc.transport.primarySessionId || !this.isReady(config.id)) {
              throw new DomainError('CLI_CONTROLLER_UNAVAILABLE', 'Controller CLI connection is unavailable', 503, true);
            }
            if (call.integrationId !== '' || !entry.config.allowControllerCli || lease.signal.aborted || entry.cliLease !== lease) {
              throw new DomainError('CLI_ACCESS_DENIED', 'Workspace CLI access is not enabled for this executor', 403);
            }
          };
          assertCurrent();
          if (!this.#cliDispatcher) throw new DomainError('CLI_CONTROLLER_UNAVAILABLE', 'Controller CLI is initializing', 503, true);
          const assertManagement = () => {
            assertCurrent();
            if (!entry.config.allowExecutorManagement) {
              throw new DomainError('CLI_ACCESS_DENIED', 'Executor management is not enabled for this executor', 403);
            }
          };
          const access = { executorId: config.id, rpc, signal: AbortSignal.any([signal, lease.signal]), assertCurrent, assertManagement };
          if (call.method === 'controllerCli.describe') {
            if (call.request !== null) throw new DomainError('VALIDATION_FAILED', 'Invalid CLI context request', 400);
            return this.#cliDispatcher.describe(access, guardReply);
          }
          return this.#cliDispatcher.request(call.request, access, guardReply);
        }
        if (call.method !== 'credentials.resolve' || !this.#current(entry)
          || !this.options.integrations.some((integration) => integration.integrationId === call.integrationId)) {
          throw new AgentCallError('rejected', 'Operation is not permitted on the controller');
        }
        return this.options.resolveCredential({ executorId: config.id, agentId: call.integrationId, reference: call.request.reference, signal });
      }), reportError, entry.inventory, { logger: this.logger });
      entry.executor.onBulkChanged(() => { if (this.#current(entry)) this.#changed(); });
      entry.executor.onAvailabilityChanged((value) => {
        if (!this.#current(entry)) return;
        if (value === 'ready') {
          const preparation = {};
          entry.preparation = preparation;
          void this.#prepare(entry, preparation).catch(() => {
            if (!this.#current(entry) || entry.preparation !== preparation) return;
            reportError('Executor inventory could not be initialized');
            link.current?.close(new Error('Executor inventory initialization failed'));
          });
        } else {
          entry.preparation = null;
          this.#publishAvailability(config.id, value);
          this.#changed();
        }
      });
      if (config.connection.kind === 'controller-connects') link.dial(config.connection.targetUrl);
    }
  }

  async #prepare(entry: ManagedRemote, preparation: object): Promise<void> {
    const executor = entry.executor!;
    const info = await executor.getInfo();
    const integrations = entry.integrations ?? new IntegrationRegistry({ instances: await Promise.all(info.integrationIds.map((id) => executor.getAgentIntegration(id))) });
    if (!this.#current(entry) || entry.preparation !== preparation || executor.availability !== 'ready') return;
    entry.info = info;
    entry.integrations = integrations;
    entry.knownIntegrations = integrations;
    entry.inventory = executor.inventory;
    entry.error = null;
    entry.preparation = null;
    this.#publishAvailability(entry.config.id, 'ready');
    this.#changed();
  }

  // A reconnected session is being prepared while the client reports ready.
  #holdsCalls(executorId: string): boolean {
    if (this.#disposed || this.#changing.has(executorId)) return false;
    const entry = this.#remotes.get(executorId);
    const availability = entry?.executor?.availability;
    return Boolean(entry?.config.enabled && entry.integrations && (availability === 'reconnecting' || availability === 'ready'));
  }

  #current(entry: ManagedRemote): boolean { return !this.#disposed && this.#remotes.get(entry.config.id) === entry; }
  #changed(): void { if (!this.#disposed) for (const listener of this.#changes) listener(); }
  #publishAvailability(executorId: string, value: ExecutorAvailability): void {
    if (!this.#disposed && !this.#quiescing) for (const listener of this.#availability) listener(executorId, value);
  }
  #snapshotAvailability(executorId: string): ExecutorSnapshotAvailability {
    if (this.isReady(executorId)) return 'ready';
    if (this.isReconnecting(executorId)) return 'reconnecting';
    return 'offline';
  }
}

// Notifies at once, then at most once per interval, each time with the latest state.
function throttledNotice(intervalMs: number, notify: () => void): () => void {
  let notifiedAt = Number.NEGATIVE_INFINITY;
  let pending: ReturnType<typeof setTimeout> | null = null;
  const fire = () => {
    pending = null;
    notifiedAt = performance.now();
    notify();
  };
  return () => {
    if (pending) return;
    const wait = notifiedAt + intervalMs - performance.now();
    if (wait <= 0) fire();
    else {
      pending = setTimeout(fire, wait);
      pending.unref();
    }
  };
}

function sameConnector(left: RemoteExecutorConfig, right: RemoteExecutorConfig): boolean {
  if (left.enabled !== right.enabled || left.secret !== right.secret || left.noTls !== right.noTls
    || left.allowUnverifiedTls !== right.allowUnverifiedTls
    || left.connection.kind !== right.connection.kind) return false;
  return left.connection.kind !== 'controller-connects' || right.connection.kind !== 'controller-connects'
    || left.connection.targetUrl === right.connection.targetUrl;
}
