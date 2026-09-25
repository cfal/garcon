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
import { ExecutorRpc } from '../transport/rpc.js';
import type { IntegrationManifest } from '../transport/rpc-protocol.js';
import type { SessionTransport } from '../transport/session-transport.js';
import type { WebSocketLink } from '../transport/websocket-link.js';
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

class ExecutorConfigurationError extends Error {}

export class RemoteExecutorClient implements ExecutionRuntimeApi {
  readonly #integrations = new Map<string, RemoteAgentIntegration>();
  readonly #listeners = new Set<(value: ExecutorAvailability) => void>();
  readonly #ready = Promise.withResolvers<void>();
  readonly #unsubscribe: () => void;
  #availability: ExecutorAvailability = 'offline';
  #current: RemoteSessionBacking | null = null;
  #candidate: SessionTransport | null = null;
  #initialized = false;
  readonly #files = new RemoteFilesService(() => this.#backing());
  readonly #git = new RemoteGitServices(() => this.#backing());
  readonly #terminals = new RemoteTerminalService(() => this.#backing());
  readonly #projects: ExecutionProjectService = {
    ticketProjectDefault: async (request, options) => parseTicketProjectDefault(await this.#backing().rpc.call('', 'projects.ticketProjectDefault', request, options)),
    inspect: async (request, options) => this.#backing().rpc.call('', 'projects.inspect', request, options),
    resolveFileMentions: async (request, options) => this.#backing().rpc.call('', 'projects.resolveFileMentions', request, options),
  };

  constructor(
    readonly id: string,
    private readonly link: WebSocketLink,
    setupRpc: (rpc: ExecutorRpc) => void = () => {},
    private readonly reportError: (message: string) => void = () => {},
    private readonly expectedInventory: RemoteExecutorInventory | null = null,
  ) {
    void this.#ready.promise.catch(() => undefined);
    this.#unsubscribe = link.onSession((transport) => {
      this.#candidate = transport;
      const rpc = new ExecutorRpc(transport);
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
      void this.#install(transport, rpc).catch((error: unknown) => {
        if (this.#candidate === transport && this.#availability !== 'disposed') {
          this.reportError(error instanceof ExecutorConfigurationError ? error.message
            : 'Executor initialization failed; check worker configuration and matching builds');
        }
        transport.close(error instanceof Error ? error : new Error(String(error)));
      });
    });
    void link.ready.catch((error: unknown) => this.#ready.reject(error));
  }

  static async connect(link: WebSocketLink, setupRpc: (rpc: ExecutorRpc) => void = () => {}): Promise<RemoteExecutorClient> {
    if (!link.executorId) throw new Error('Remote executor requires a controller link');
    const executor = new RemoteExecutorClient(link.executorId, link, setupRpc);
    try { await executor.#ready.promise; return executor; }
    catch (error) { await executor.dispose(); throw error; }
  }

  get availability(): ExecutorAvailability { return this.#availability; }

  get inventory(): RemoteExecutorInventory | null {
    return !this.#initialized ? null : {
      integrations: [...this.#integrations.values()].map((integration) => integration.manifest),
    };
  }

  async getInfo(options?: ExecutorCallOptions): Promise<ExecutorInfo> {
    options?.signal?.throwIfAborted();
    return this.#backing().info;
  }

  async getAgentIntegration(agentId: string, options?: ExecutorCallOptions) {
    options?.signal?.throwIfAborted();
    this.#backing();
    const integration = this.#integrations.get(agentId);
    if (!integration) throw new AgentCallError('not-dispatched', 'Integration is unavailable on this executor', 'OPERATION_UNSUPPORTED');
    return integration;
  }

  async getProcessService(): Promise<never> { throw unavailableService('processes'); }
  async discoverApiProviderModels(request: ApiProviderDiscoveryRequest, options?: ExecutorCallOptions) {
    return this.#backing().rpc.call('', 'apiProviders.discoverModels', request, {
      ...options, timeoutMs: options?.timeoutMs ?? MODEL_DISCOVERY_TIMEOUT_MS + 5_000,
    });
  }
  async getProjectService(options?: ExecutorCallOptions): Promise<ExecutionProjectService> {
    options?.signal?.throwIfAborted();
    this.#backing();
    return this.#projects;
  }
  async getFilesService(options?: ExecutorCallOptions) {
    options?.signal?.throwIfAborted();
    if (!this.#backing().info.services.files) throw unavailableService('files');
    return this.#files;
  }
  async getGitService(options?: ExecutorCallOptions) {
    options?.signal?.throwIfAborted();
    if (!this.#backing().info.services.git) throw unavailableService('git');
    return this.#git.git;
  }
  async getGhService(options?: ExecutorCallOptions) {
    options?.signal?.throwIfAborted();
    if (!this.#backing().info.services.gh) throw unavailableService('gh');
    return this.#git.gh;
  }
  async getTerminalService(options?: ExecutorCallOptions) {
    options?.signal?.throwIfAborted();
    if (!this.#backing().info.services.terminals) throw unavailableService('terminals');
    return this.#terminals;
  }

  onAvailabilityChanged(listener: (value: ExecutorAvailability) => void): () => void {
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

  async #install(transport: SessionTransport, rpc: ExecutorRpc): Promise<void> {
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
    const candidates = initial ? new Map([...manifests.values()].map((manifest) => [
      manifest.descriptor.id, new RemoteAgentIntegration(manifest, () => this.#backing()),
    ])) : this.#integrations;
    if (!initial) {
      if (this.#integrations.size !== manifests.size) throw new ExecutorConfigurationError('Executor provider inventory changed; restart the controller to accept it');
      for (const [id, integration] of this.#integrations) {
        const { scope: _oldScope, ...previous } = integration.manifest;
        const { scope: _newScope, ...replacement } = manifests.get(id) ?? {};
        if (!isDeepStrictEqual(previous, replacement)) throw new ExecutorConfigurationError('Executor provider capabilities changed; restart the controller to accept them');
      }
    }
    for (const integration of candidates.values()) await integration.initializeReplacement(backing, initial);
    if (this.#candidate !== transport || this.#availability === 'disposed' || !transport.connected) {
      throw new Error('Executor candidate session retired');
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
      throw new AgentCallError('not-dispatched', `Executor is ${this.#availability}`);
    }
    return this.#current;
  }

  #setAvailability(value: ExecutorAvailability): void {
    if (this.#availability === value) return;
    this.#availability = value;
    for (const listener of this.#listeners) listener(value);
  }
}
