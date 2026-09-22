import { isDeepStrictEqual } from 'node:util';
import {
  AgentCallError,
  type ExecutionNode,
  type ExecutionNodeInfo,
  type ExecutionProjectService,
  type NodeAvailability,
  type NodeCallOptions,
  type ApiProviderDiscoveryRequest,
} from '@garcon/server-agent-interface';
import { RemoteAgentIntegration } from './remote-agent-integration.js';
import { AgentRpc } from './rpc.js';
import type { IntegrationManifest } from './agent-protocol.js';
import type { SessionTransport } from './session-transport.js';
import type { WebSocketLink } from './websocket-link.js';
import { unavailableService } from './in-process.js';
import { MODEL_DISCOVERY_TIMEOUT_MS } from '../api-providers/discovery.js';
import { RemoteExecutionFilesService } from './remote-files.js';
import { RemoteExecutionTerminalService } from './remote-terminals.js';

export interface RemoteSessionBacking {
  readonly rpc: AgentRpc;
  readonly info: ExecutionNodeInfo;
  readonly manifests: ReadonlyMap<string, IntegrationManifest>;
}

export interface RemoteNodeInventory {
  readonly integrations: readonly IntegrationManifest[];
}

class NodeConfigurationError extends Error {}

export class RemoteExecutionNode implements ExecutionNode {
  readonly #integrations = new Map<string, RemoteAgentIntegration>();
  readonly #listeners = new Set<(value: NodeAvailability) => void>();
  readonly #ready = Promise.withResolvers<void>();
  readonly #unsubscribe: () => void;
  #availability: NodeAvailability = 'offline';
  #current: RemoteSessionBacking | null = null;
  #candidate: SessionTransport | null = null;
  #initialized = false;
  readonly #files = new RemoteExecutionFilesService(() => this.#backing());
  readonly #terminals = new RemoteExecutionTerminalService(() => this.#backing());
  readonly #projects: ExecutionProjectService = {
    inspect: async (request, options) => this.#backing().rpc.call('', 'projects.inspect', request, options),
    resolveFileMentions: async (request, options) => this.#backing().rpc.call('', 'projects.resolveFileMentions', request, options),
  };

  constructor(
    readonly id: string,
    private readonly link: WebSocketLink,
    setupRpc: (rpc: AgentRpc) => void = () => {},
    private readonly reportError: (message: string) => void = () => {},
    private readonly expectedInventory: RemoteNodeInventory | null = null,
  ) {
    void this.#ready.promise.catch(() => undefined);
    this.#unsubscribe = link.onSession((transport) => {
      this.#candidate = transport;
      const rpc = new AgentRpc(transport);
      rpc.onTerminal((frame) => this.#terminals.receive(frame, rpc));
      setupRpc(rpc);
      transport.onFailure(() => {
        rpc.retireUnknown();
        if (this.#availability === 'disposed' || this.#candidate !== transport) return;
        this.#terminals.disconnect();
        this.#current = null;
        for (const integration of this.#integrations.values()) integration.retire();
        this.#setAvailability('offline');
      });
      transport.onAvailability((connected) => {
        if (this.#current?.rpc !== rpc || this.#availability === 'disposed') return;
        if (!connected) this.#terminals.disconnect();
        this.#setAvailability(connected ? 'ready' : 'reconnecting');
      });
      void this.#install(transport, rpc).catch((error: unknown) => {
        if (this.#candidate === transport && this.#availability !== 'disposed') {
          this.reportError(error instanceof NodeConfigurationError ? error.message
            : 'Execution-node initialization failed; check worker configuration and matching builds');
        }
        transport.close(error instanceof Error ? error : new Error(String(error)));
      });
    });
    void link.ready.catch((error: unknown) => this.#ready.reject(error));
  }

  static async connect(link: WebSocketLink, setupRpc: (rpc: AgentRpc) => void = () => {}): Promise<RemoteExecutionNode> {
    if (!link.nodeId) throw new Error('Remote node requires a controller link');
    const node = new RemoteExecutionNode(link.nodeId, link, setupRpc);
    try { await node.#ready.promise; return node; }
    catch (error) { await node.dispose(); throw error; }
  }

  get availability(): NodeAvailability { return this.#availability; }

  get inventory(): RemoteNodeInventory | null {
    return !this.#initialized ? null : {
      integrations: [...this.#integrations.values()].map((integration) => integration.manifest),
    };
  }

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
  async discoverApiProviderModels(request: ApiProviderDiscoveryRequest, options?: NodeCallOptions) {
    return this.#backing().rpc.call('', 'apiProviders.discoverModels', request, {
      ...options, timeoutMs: options?.timeoutMs ?? MODEL_DISCOVERY_TIMEOUT_MS + 5_000,
    });
  }
  async getProjectService(options?: NodeCallOptions): Promise<ExecutionProjectService> {
    options?.signal?.throwIfAborted();
    this.#backing();
    return this.#projects;
  }
  async getFilesService(options?: NodeCallOptions) {
    options?.signal?.throwIfAborted();
    if (!this.#backing().info.services.files) throw unavailableService('files');
    return this.#files;
  }
  async getGitService(): Promise<never> { throw unavailableService('git'); }
  async getTerminalService(options?: NodeCallOptions) {
    options?.signal?.throwIfAborted();
    if (!this.#backing().info.services.terminals) throw unavailableService('terminals');
    return this.#terminals;
  }

  onAvailabilityChanged(listener: (value: NodeAvailability) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  async dispose(): Promise<void> {
    if (this.#availability === 'disposed') return;
    this.#setAvailability('disposed');
    this.#unsubscribe();
    this.#terminals.disconnect();
    this.#current = null;
    for (const integration of this.#integrations.values()) integration.retire();
    await this.link.dispose();
    this.#listeners.clear();
  }

  async #install(transport: SessionTransport, rpc: AgentRpc): Promise<void> {
    await transport.ready;
    const { info, integrations } = await rpc.call('', 'node.describe', null);
    if (info.nodeId !== this.id || transport.nodeId !== this.id) throw new NodeConfigurationError('Execution-node identity mismatch');
    if (typeof info.projectBasePath !== 'string' || !info.projectBasePath) throw new NodeConfigurationError('Execution-node project base is missing');
    const manifests = new Map<string, IntegrationManifest>();
    for (const manifest of integrations) {
      if (manifest.scope.nodeId !== info.nodeId || manifest.scope.instanceId !== info.instanceId
        || manifest.scope.integrationId !== manifest.descriptor.id || manifests.has(manifest.descriptor.id)) {
        throw new NodeConfigurationError('Execution-node integration scope mismatch');
      }
      manifests.set(manifest.descriptor.id, manifest);
    }
    if (manifests.size !== info.integrationIds.length || info.integrationIds.some((id) => !manifests.has(id))) {
      throw new NodeConfigurationError('Execution-node integration inventory mismatch');
    }
    if (this.expectedInventory) {
      if (manifests.size !== this.expectedInventory.integrations.length
        || this.expectedInventory.integrations.some(({ scope: _scope, ...expected }) => {
          const { scope: _replacementScope, ...replacement } = manifests.get(expected.descriptor.id) ?? {};
          return !isDeepStrictEqual(expected, replacement);
        })) throw new NodeConfigurationError('Execution-node provider inventory changed; restart the controller to accept it');
    }
    const backing: RemoteSessionBacking = { rpc, info, manifests };
    const initial = !this.#initialized;
    const candidates = initial ? new Map([...manifests.values()].map((manifest) => [
      manifest.descriptor.id, new RemoteAgentIntegration(manifest, () => this.#backing()),
    ])) : this.#integrations;
    if (!initial) {
      if (this.#integrations.size !== manifests.size) throw new NodeConfigurationError('Execution-node provider inventory changed; restart the controller to accept it');
      for (const [id, integration] of this.#integrations) {
        const { scope: _oldScope, ...previous } = integration.manifest;
        const { scope: _newScope, ...replacement } = manifests.get(id) ?? {};
        if (!isDeepStrictEqual(previous, replacement)) throw new NodeConfigurationError('Execution-node provider capabilities changed; restart the controller to accept them');
      }
    }
    for (const integration of candidates.values()) await integration.initializeReplacement(backing, initial);
    if (this.#candidate !== transport || this.#availability === 'disposed' || !transport.connected) {
      throw new Error('Execution-node candidate session retired');
    }
    if (initial) {
      for (const [id, integration] of candidates) this.#integrations.set(id, integration);
      this.#initialized = true;
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
