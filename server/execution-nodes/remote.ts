import { isDeepStrictEqual } from 'node:util';
import {
  AgentCallError,
  type ExecutionNode,
  type ExecutionNodeInfo,
  type ExecutionProjectService,
  type NodeAvailability,
  type NodeCallOptions,
} from '@garcon/server-agent-interface';
import { RemoteAgentIntegration } from './remote-agent-integration.js';
import { AgentRpc } from './rpc.js';
import type { IntegrationManifest } from './agent-protocol.js';
import type { SessionTransport } from './session-transport.js';
import type { WebSocketLink } from './websocket-link.js';
import { unavailableService } from './in-process.js';

export interface RemoteSessionBacking {
  readonly rpc: AgentRpc;
  readonly info: ExecutionNodeInfo;
  readonly manifests: ReadonlyMap<string, IntegrationManifest>;
}

export class RemoteExecutionNode implements ExecutionNode {
  readonly #integrations = new Map<string, RemoteAgentIntegration>();
  readonly #listeners = new Set<(value: NodeAvailability) => void>();
  readonly #ready = Promise.withResolvers<void>();
  readonly #unsubscribe: () => void;
  #availability: NodeAvailability = 'reconnecting';
  #current: RemoteSessionBacking | null = null;
  #candidate: SessionTransport | null = null;
  #id: string | null = null;
  #projectBasePath: string | null = null;
  readonly #projects: ExecutionProjectService = {
    inspect: async (request, options) => this.#backing().rpc.call('', 'projects.inspect', request, options),
    resolveFileMentions: async (request, options) => this.#backing().rpc.call('', 'projects.resolveFileMentions', request, options),
  };

  private constructor(private readonly link: WebSocketLink, setupRpc: (rpc: AgentRpc) => void) {
    this.#unsubscribe = link.onSession((transport) => {
      this.#candidate = transport;
      const rpc = new AgentRpc(transport);
      setupRpc(rpc);
      transport.onFailure(() => {
        rpc.retireUnknown();
        if (this.#availability === 'disposed' || this.#candidate !== transport) return;
        this.#current = null;
        for (const integration of this.#integrations.values()) integration.retire();
        this.#setAvailability('offline');
      });
      transport.onAvailability((connected) => {
        if (this.#current?.rpc !== rpc || this.#availability === 'disposed') return;
        this.#setAvailability(connected ? 'ready' : 'reconnecting');
      });
      void this.#install(transport, rpc).catch((error: unknown) => {
        console.warn('Execution-node session initialization failed:', error instanceof Error ? error.message : String(error));
        transport.close(error instanceof Error ? error : new Error(String(error)));
        if (!this.#id) this.#ready.reject(error);
      });
    });
    void link.ready.catch((error: unknown) => this.#ready.reject(error));
  }

  static async connect(link: WebSocketLink, setupRpc: (rpc: AgentRpc) => void = () => {}): Promise<RemoteExecutionNode> {
    const node = new RemoteExecutionNode(link, setupRpc);
    try { await node.#ready.promise; return node; }
    catch (error) { await node.dispose(); throw error; }
  }

  get id(): string { return this.#id!; }
  get availability(): NodeAvailability { return this.#availability; }

  async getInfo(options?: NodeCallOptions): Promise<ExecutionNodeInfo> {
    options?.signal?.throwIfAborted();
    return this.#backing().info;
  }

  async getAgentIntegration(agentId: string, options?: NodeCallOptions) {
    options?.signal?.throwIfAborted();
    this.#backing();
    const integration = this.#integrations.get(agentId);
    if (!integration) throw new AgentCallError('not-dispatched', 'Integration is unavailable on this node', 'OPERATION_UNSUPPORTED');
    return integration;
  }

  async getProcessService(): Promise<never> { throw unavailableService('processes'); }
  async getProjectService(options?: NodeCallOptions): Promise<ExecutionProjectService> {
    options?.signal?.throwIfAborted();
    this.#backing();
    return this.#projects;
  }
  async getFilesService(): Promise<never> { throw unavailableService('files'); }
  async getGitService(): Promise<never> { throw unavailableService('git'); }
  async getTerminalService(): Promise<never> { throw unavailableService('terminals'); }

  onAvailabilityChanged(listener: (value: NodeAvailability) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  async dispose(): Promise<void> {
    if (this.#availability === 'disposed') return;
    this.#setAvailability('disposed');
    this.#unsubscribe();
    this.#current = null;
    for (const integration of this.#integrations.values()) integration.retire();
    await this.link.dispose();
    this.#listeners.clear();
  }

  async #install(transport: SessionTransport, rpc: AgentRpc): Promise<void> {
    await transport.ready;
    const { info, integrations } = await rpc.call('', 'node.describe', null);
    if (typeof info.projectBasePath !== 'string' || !info.projectBasePath) throw new Error('Execution-node project base is missing');
    if (this.#projectBasePath !== null && this.#projectBasePath !== info.projectBasePath) {
      throw new Error('Execution-node project base changed; restart the controller to accept it');
    }
    const manifests = new Map<string, IntegrationManifest>();
    for (const manifest of integrations) {
      if (manifest.scope.nodeId !== info.nodeId || manifest.scope.instanceId !== info.instanceId
        || manifest.scope.integrationId !== manifest.descriptor.id || manifests.has(manifest.descriptor.id)) {
        throw new Error('Execution-node integration scope mismatch');
      }
      manifests.set(manifest.descriptor.id, manifest);
    }
    if (manifests.size !== info.integrationIds.length || info.integrationIds.some((id) => !manifests.has(id))) {
      throw new Error('Execution-node integration inventory mismatch');
    }
    const backing: RemoteSessionBacking = { rpc, info, manifests };
    if (this.#id) {
      if (this.#id !== info.nodeId || this.#integrations.size !== manifests.size) throw new Error('Execution-node inventory changed');
      for (const [id, integration] of this.#integrations) {
        const { scope: _oldScope, ...previous } = integration.manifest;
        const { scope: _newScope, ...replacement } = manifests.get(id) ?? {};
        if (!isDeepStrictEqual(previous, replacement)) throw new Error('Execution-node capabilities changed');
        await integration.initializeReplacement(backing);
      }
    }
    if (this.#candidate !== transport || this.#availability === 'disposed' || !transport.connected) {
      throw new Error('Execution-node candidate session retired');
    }
    if (!this.#id) {
      for (const manifest of manifests.values()) {
        this.#integrations.set(manifest.descriptor.id, new RemoteAgentIntegration(manifest, () => this.#backing()));
      }
      this.#id = info.nodeId;
      this.#projectBasePath = info.projectBasePath;
    }
    rpc.onProducer(({ notification }) => {
      if (this.#current !== backing) return;
      const integration = this.#integrations.get(notification.binding.integrationId);
      if (!integration) throw new Error('Unknown producer integration');
      integration.receive(notification, backing);
    });
    this.#current = backing;
    this.#setAvailability('ready');
    this.#ready.resolve();
  }

  #backing(): RemoteSessionBacking {
    if (!this.#current || !this.#current.rpc.transport.connected) {
      throw new AgentCallError('not-dispatched', `Execution node is ${this.#availability}`);
    }
    return this.#current;
  }

  #setAvailability(value: NodeAvailability): void {
    if (this.#availability === value) return;
    this.#availability = value;
    for (const listener of this.#listeners) listener(value);
  }
}
