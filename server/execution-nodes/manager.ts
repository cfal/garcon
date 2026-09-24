import {
  AgentCallError, type AgentIntegration, type ExecutionNode, type ExecutionNodeInfo,
  type ExecutionProjectService, type NodeAvailability,
} from '@garcon/server-agent-interface';
import {
  effectiveNodeId, LOCAL_EXECUTION_NODE_ID, type AgentExecutionTarget,
  type CreateExecutionNodeRequest, type ExecutionNodeSnapshot, type UpdateExecutionNodeRequest,
} from '../../common/execution-nodes.js';
import { IntegrationRegistry } from '../agents/integration-registry.js';
import { DomainError } from '../lib/domain-error.js';
import { ExecutionNodeConfigStore, type RemoteNodeConfig } from './config-store.js';
import { InProcessExecutionNode } from './in-process.js';
import { RemoteExecutionNode, type RemoteNodeInventory } from './remote.js';
import { WebSocketLink } from './websocket-link.js';
import { ExecutionNodeReferenceWrites } from './reference-writes.js';
import type { ControllerCliDispatcher } from './cli-dispatcher.js';

type LocalNodeOptions = ConstructorParameters<typeof InProcessExecutionNode>[0];

interface ManagedRemote {
  config: RemoteNodeConfig;
  node: RemoteExecutionNode | null;
  link: WebSocketLink | null;
  integrations: IntegrationRegistry | null;
  knownIntegrations: IntegrationRegistry | null;
  inventory: RemoteNodeInventory | null;
  info: ExecutionNodeInfo | null;
  error: ExecutionNodeSnapshot['lastError'];
  preparation: object | null;
  cliLease: AbortController;
}

export class ExecutionNodeManager {
  readonly #remotes = new Map<string, ManagedRemote>();
  readonly #changes = new Set<() => void>();
  readonly #availability = new Set<(nodeId: string, value: NodeAvailability) => void>();
  readonly #changing = new Set<string>();
  readonly #referenceWrites = new ExecutionNodeReferenceWrites((nodeId) => {
    if (this.#disposed || this.#quiescing || this.#changing.has(nodeId)) {
      throw new DomainError('EXECUTION_NODE_IN_USE', 'This execution node is being changed. Try saving again after the change finishes.', 409, true);
    }
    this.config.require(nodeId);
  });
  readonly retainReferences = this.#referenceWrites.retain;
  #mutations: Promise<unknown> = Promise.resolve();
  #disposed = false;
  #quiescing = false;
  #cliDispatcher: ControllerCliDispatcher | null = null;
  #guards = { assertIdle: (_id: string) => {}, assertRemovable: (_id: string) => {} };

  private constructor(
    readonly local: InProcessExecutionNode,
    readonly localIntegrations: IntegrationRegistry,
    readonly localInfo: ExecutionNodeInfo,
    readonly config: ExecutionNodeConfigStore,
    private readonly options: LocalNodeOptions,
  ) {}

  static async create(options: LocalNodeOptions): Promise<ExecutionNodeManager> {
    const config = new ExecutionNodeConfigStore(options.workspaceDir);
    await config.initialize();
    const local = new InProcessExecutionNode({ ...options, id: LOCAL_EXECUTION_NODE_ID });
    try {
      const info = await local.getInfo();
      const integrations = new IntegrationRegistry({ instances: await Promise.all(info.integrationIds.map((id) => local.getAgentIntegration(id))) });
      const manager = new ExecutionNodeManager(local, integrations, info, config, options);
      await manager.#applyConfig();
      return manager;
    } catch (error) { await local.dispose(); throw error; }
  }

  setGuards(guards: { assertIdle(nodeId: string): void; assertRemovable(nodeId: string): void }): void {
    this.#guards = guards;
  }

  setCliDispatcher(dispatcher: ControllerCliDispatcher): void { this.#cliDispatcher = dispatcher; }

  isReady(nodeId: string): boolean {
    if (this.#disposed || this.#changing.has(nodeId)) return false;
    if (nodeId === LOCAL_EXECUTION_NODE_ID) return this.local.availability === 'ready';
    const entry = this.#remotes.get(nodeId);
    return Boolean(entry?.config.enabled && !entry.preparation && entry.integrations && entry.node?.availability === 'ready');
  }

  requireNode(nodeId: string): ExecutionNode {
    if (!this.isReady(nodeId)) throw new DomainError('EXECUTION_NODE_UNAVAILABLE', 'Execution node is unavailable', 503, true);
    return nodeId === LOCAL_EXECUTION_NODE_ID ? this.local : this.#remotes.get(nodeId)!.node!;
  }

  integrationsFor(nodeId: string): IntegrationRegistry {
    this.requireNode(nodeId);
    return nodeId === LOCAL_EXECUTION_NODE_ID ? this.localIntegrations : this.#remotes.get(nodeId)!.integrations!;
  }

  knownIntegration(target: AgentExecutionTarget): AgentIntegration | null {
    return (target.nodeId === LOCAL_EXECUTION_NODE_ID ? this.localIntegrations : this.#remotes.get(target.nodeId)?.knownIntegrations)?.get(target.agentId) ?? null;
  }

  requireIntegration(target: AgentExecutionTarget): AgentIntegration {
    return this.integrationsFor(target.nodeId).require(target.agentId);
  }

  async projectService(nodeId: string): Promise<ExecutionProjectService> {
    return this.requireNode(nodeId).getProjectService();
  }

  inspectProject = async (projectPath: string, nodeId?: string | null) => (
    (await (await this.projectService(effectiveNodeId(nodeId))).inspect({ projectPath })).resolution
  );

  resolveFileMentions = async (command: string, projectPath: string, nodeId?: string | null): Promise<string> => (
    (await this.projectService(effectiveNodeId(nodeId))).resolveFileMentions({ command, projectPath })
  );

  list(): readonly ExecutionNodeSnapshot[] {
    return [{
      id: LOCAL_EXECUTION_NODE_ID, label: 'Local', kind: 'local', enabled: true, direction: null,
      allowControllerCli: true,
      availability: this.#disposed ? 'offline' : 'ready', projectBasePath: this.localInfo.projectBasePath,
      instanceId: this.localInfo.instanceId,
      lastError: null, machineServices: { files: true, git: true, gh: true, terminals: true },
    }, ...[...this.#remotes.values()].map((entry): ExecutionNodeSnapshot => ({
      id: entry.config.id, label: entry.config.label, kind: 'remote', enabled: entry.config.enabled,
      allowControllerCli: entry.config.allowControllerCli,
      direction: entry.config.connection.kind,
      availability: this.isReady(entry.config.id) ? 'ready' : 'offline',
      projectBasePath: entry.info?.projectBasePath ?? null, lastError: entry.error,
      instanceId: entry.info?.instanceId ?? null,
      machineServices: { files: entry.info?.services.files === true, git: entry.info?.services.git === true, gh: entry.info?.services.gh === true, terminals: entry.info?.services.terminals === true },
    }))];
  }

  inboundLink(nodeId: string): WebSocketLink | null {
    const entry = this.#remotes.get(nodeId);
    return !this.#disposed && !this.#changing.has(nodeId) && entry?.config.enabled
      && entry.config.connection.kind === 'node-connects' && entry.link?.acceptsSocket ? entry.link : null;
  }

  onChanged(listener: () => void): () => void {
    this.#changes.add(listener);
    return () => { this.#changes.delete(listener); };
  }

  onAvailabilityChanged(listener: (nodeId: string, value: NodeAvailability) => void): () => void {
    this.#availability.add(listener);
    return () => { this.#availability.delete(listener); };
  }

  create(request: CreateExecutionNodeRequest): Promise<RemoteNodeConfig> {
    return this.#mutate(null, async () => this.config.create(request));
  }

  update(id: string, request: UpdateExecutionNodeRequest): Promise<RemoteNodeConfig> {
    return this.#mutate(request.connection || request.enabled !== undefined ? id : null, async () => this.config.update(id, request));
  }

  remove(id: string): Promise<void> {
    return this.#mutate(id, async () => {
      this.#referenceWrites.assertNoWrites(id);
      this.#guards.assertRemovable(id);
      await this.config.remove(id);
    });
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const entry of this.#remotes.values()) entry.cliLease.abort();
    await this.#mutations.catch(() => undefined);
    await Promise.allSettled([...this.#remotes.values()].map((entry) => entry.node?.dispose()));
    this.#remotes.clear();
    await this.local.dispose();
    this.#changes.clear();
    this.#availability.clear();
  }

  quiesce(): void {
    this.#quiescing = true;
    for (const entry of this.#remotes.values()) { entry.cliLease.abort(); entry.link?.quiesce(); }
  }

  #mutate<T>(nodeId: string | null, operation: () => Promise<T>): Promise<T> {
    const result = this.#mutations.then(async () => {
      if (this.#disposed || this.#quiescing) throw new DomainError('SERVER_SHUTTING_DOWN', 'Execution nodes are stopping', 503);
      if (nodeId !== null) {
        this.config.require(nodeId);
        this.#guards.assertIdle(nodeId);
        this.#changing.add(nodeId);
      }
      try { return await operation(); }
      finally {
        try { if (!this.#disposed) await this.#applyConfig(); }
        finally {
          if (nodeId !== null) {
            this.#changing.delete(nodeId);
            if (this.isReady(nodeId)) this.#publishAvailability(nodeId, 'ready');
          }
          this.#changed();
        }
      }
    });
    this.#mutations = result.catch(() => undefined);
    return result;
  }

  async #applyConfig(): Promise<void> {
    const nodes = this.config.list();
    const previous = new Map(this.#remotes);
    for (const [id, entry] of this.#remotes) {
      const next = nodes.find((node) => node.id === id);
      if (next && sameConnector(entry.config, next)) {
        if (next.allowControllerCli !== entry.config.allowControllerCli) {
          entry.cliLease.abort();
          entry.cliLease = new AbortController();
        }
        entry.config = next;
        continue;
      }
      entry.cliLease.abort();
      this.#remotes.delete(id);
      await entry.node?.dispose();
      this.#publishAvailability(id, 'offline');
    }
    for (const config of nodes) {
      if (this.#remotes.has(config.id)) continue;
      const known = previous.get(config.id);
      const entry: ManagedRemote = { config, node: null, link: null, integrations: null,
        knownIntegrations: known?.knownIntegrations ?? null, inventory: known?.inventory ?? null,
        info: known?.info ?? null, error: null, preparation: null, cliLease: new AbortController() };
      this.#remotes.set(config.id, entry);
      if (!config.enabled) continue;
      const reportError = (message: string) => {
        if (!this.#current(entry)) return;
        entry.error = { code: 'EXECUTION_NODE_UNAVAILABLE', message };
        this.#changed();
      };
      const link = new WebSocketLink({ role: 'controller', nodeId: config.id, secret: config.secret,
        allowInsecureDevelopment: config.allowInsecureDevelopment, allowUnverifiedTls: config.allowUnverifiedTls });
      entry.link = link;
      link.onError(reportError);
      entry.node = new RemoteExecutionNode(config.id, link, (rpc) => rpc.handle(async (call, signal, guardReply) => {
        if (call.method === 'controllerCli.describe' || call.method === 'controllerCli.request') {
          const lease = entry.cliLease;
          const assertCurrent = () => {
            if (!this.#current(entry) || this.#quiescing || entry.link?.current !== rpc.transport || !this.isReady(config.id)) {
              throw new DomainError('CLI_CONTROLLER_UNAVAILABLE', 'Controller CLI connection is unavailable', 503, true);
            }
            if (call.integrationId !== '' || !entry.config.allowControllerCli || lease.signal.aborted || entry.cliLease !== lease) {
              throw new DomainError('CLI_ACCESS_DENIED', 'Workspace CLI access is not enabled for this execution node', 403);
            }
          };
          assertCurrent();
          if (!this.#cliDispatcher) throw new DomainError('CLI_CONTROLLER_UNAVAILABLE', 'Controller CLI is initializing', 503, true);
          const access = { nodeId: config.id, rpc, signal: AbortSignal.any([signal, lease.signal]), assertCurrent };
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
        return this.options.resolveCredential({ nodeId: config.id, agentId: call.integrationId, reference: call.request.reference, signal });
      }, (call, bytes) => this.#cliDispatcher?.admitReply(call, rpc, bytes)), reportError, entry.inventory);
      entry.node.onAvailabilityChanged((value) => {
        if (!this.#current(entry)) return;
        if (value === 'ready') {
          const preparation = {};
          entry.preparation = preparation;
          void this.#prepare(entry, preparation).catch(() => {
            if (!this.#current(entry) || entry.preparation !== preparation) return;
            reportError('Execution-node inventory could not be initialized');
            link.current?.close(new Error('Execution-node inventory initialization failed'));
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
    const node = entry.node!;
    const info = await node.getInfo();
    const integrations = entry.integrations ?? new IntegrationRegistry({ instances: await Promise.all(info.integrationIds.map((id) => node.getAgentIntegration(id))) });
    if (!this.#current(entry) || entry.preparation !== preparation || node.availability !== 'ready') return;
    entry.info = info;
    entry.integrations = integrations;
    entry.knownIntegrations = integrations;
    entry.inventory = node.inventory;
    entry.error = null;
    entry.preparation = null;
    this.#publishAvailability(entry.config.id, 'ready');
    this.#changed();
  }

  #current(entry: ManagedRemote): boolean { return !this.#disposed && this.#remotes.get(entry.config.id) === entry; }
  #changed(): void { if (!this.#disposed) for (const listener of this.#changes) listener(); }
  #publishAvailability(nodeId: string, value: NodeAvailability): void {
    if (!this.#disposed && !this.#quiescing) for (const listener of this.#availability) listener(nodeId, value);
  }
}

function sameConnector(left: RemoteNodeConfig, right: RemoteNodeConfig): boolean {
  if (left.enabled !== right.enabled || left.secret !== right.secret || left.allowInsecureDevelopment !== right.allowInsecureDevelopment
    || left.allowUnverifiedTls !== right.allowUnverifiedTls
    || left.connection.kind !== right.connection.kind) return false;
  return left.connection.kind !== 'controller-connects' || right.connection.kind !== 'controller-connects'
    || left.connection.targetUrl === right.connection.targetUrl;
}
