import {
  AgentCallError,
  type AgentIntegrationClass,
  type ExecutionRuntimeApi,
  type ExecutorInfo,
  type ExecutorAvailability,
  type ExecutorCallOptions,
  type ApiProviderDiscoveryRequest,
} from '@garcon/server-agent-interface';
import { IntegrationHostFactory, type IntegrationHostFactoryOptions } from './agents/integration-host.js';
import { IntegrationRegistry } from './agents/integration-registry.js';
import { ProjectService } from './projects/project-service.js';
import { discoverApiProviderModels } from './providers/discovery.js';
import { FilesService } from './files/service.js';
import { TerminalRuntime, type TerminalService } from './terminals/runtime.js';
import { GitRuntime } from './git/runtime.js';

export class ExecutionRuntime implements ExecutionRuntimeApi {
  readonly id: string;
  readonly #info: ExecutorInfo;
  readonly #registry: IntegrationRegistry;
  readonly #projects: ProjectService;
  readonly #files: FilesService;
  readonly #git: GitRuntime;
  readonly #listeners = new Set<(value: ExecutorAvailability) => void>();
  #disposed = false;
  readonly #terminalRuntime: TerminalRuntime;
  readonly #ownsTerminalRuntime: boolean;
  readonly #terminals: TerminalService;

  constructor(options: IntegrationHostFactoryOptions & {
    readonly id: string;
    readonly integrations: readonly AgentIntegrationClass[];
    readonly projectBasePath: string;
    readonly userShell?: string;
    readonly terminalRuntime?: TerminalRuntime;
  }) {
    this.id = options.id;
    this.#ownsTerminalRuntime = !options.terminalRuntime;
    this.#terminalRuntime = options.terminalRuntime ?? new TerminalRuntime({ projectBasePath: options.projectBasePath, userShell: options.userShell });
    this.#terminals = this.#terminalRuntime.service(options.id);
    this.#projects = new ProjectService(options.projectBasePath, (callOptions) => this.#assertAvailable(callOptions));
    this.#files = new FilesService({ executorId: options.id, projectBasePath: options.projectBasePath, assertAvailable: (callOptions) => this.#assertAvailable(callOptions) });
    const instanceId = options.instanceId ?? crypto.randomUUID();
    this.#git = new GitRuntime({ executorId: options.id, instanceId, projectBasePath: options.projectBasePath, assertAvailable: (callOptions) => this.#assertAvailable(callOptions) });
    this.#registry = new IntegrationRegistry({
      integrations: options.integrations,
      hostFactory: new IntegrationHostFactory({ ...options, executorId: options.id, instanceId }),
    });
    this.#info = Object.freeze({
      executorId: options.id,
      instanceId,
      projectBasePath: this.#projects.projectBasePath,
      integrationIds: Object.freeze(this.#registry.list().map((integration) => integration.descriptor.id)),
      services: Object.freeze({ files: true, git: true, gh: true, terminals: true }),
    });
  }

  get availability(): ExecutorAvailability { return this.#disposed ? 'disposed' : 'ready'; }

  async getInfo(options?: ExecutorCallOptions): Promise<ExecutorInfo> {
    this.#assertAvailable(options);
    return this.#info;
  }

  async getAgentIntegration(agentId: string, options?: ExecutorCallOptions) {
    this.#assertAvailable(options);
    return this.#registry.require(agentId);
  }

  async discoverApiProviderModels(request: ApiProviderDiscoveryRequest, options?: ExecutorCallOptions) {
    this.#assertAvailable(options);
    return discoverApiProviderModels(request, options);
  }
  async getProjectService(options?: ExecutorCallOptions) {
    this.#assertAvailable(options);
    return this.#projects;
  }
  async getFilesService(options?: ExecutorCallOptions) { this.#assertAvailable(options); return this.#files; }
  async getGitService(options?: ExecutorCallOptions) { this.#assertAvailable(options); return this.#git.git; }
  async getGhService(options?: ExecutorCallOptions) { this.#assertAvailable(options); return this.#git.gh; }
  async getTerminalService(options?: ExecutorCallOptions) { this.#assertAvailable(options); return this.#terminals; }

  onAvailabilityChanged(listener: (value: ExecutorAvailability) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#git.dispose();
    this.#terminals.dispose();
    if (this.#ownsTerminalRuntime) this.#terminalRuntime.shutdown();
    for (const listener of this.#listeners) listener('disposed');
    this.#listeners.clear();
    await Promise.allSettled(this.#registry.list().map((integration) => integration.lifecycle.stop()));
  }

  #assertAvailable(options?: ExecutorCallOptions): void {
    options?.signal?.throwIfAborted();
    if (this.#disposed) throw new AgentCallError('not-dispatched', 'Executor is disposed');
  }
}
