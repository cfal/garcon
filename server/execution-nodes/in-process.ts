import {
  AgentCallError,
  type AgentIntegrationClass,
  type ExecutionNode,
  type ExecutionNodeInfo,
  type NodeAvailability,
  type NodeCallOptions,
} from '@garcon/server-agent-interface';
import { IntegrationHostFactory, type IntegrationHostFactoryOptions } from '../agents/integration-host.js';
import { IntegrationRegistry } from '../agents/integration-registry.js';
import { LocalExecutionProjectService } from './project-service.js';

export class InProcessExecutionNode implements ExecutionNode {
  readonly id: string;
  readonly #info: ExecutionNodeInfo;
  readonly #registry: IntegrationRegistry;
  readonly #projects: LocalExecutionProjectService;
  readonly #listeners = new Set<(value: NodeAvailability) => void>();
  #disposed = false;

  constructor(options: IntegrationHostFactoryOptions & {
    readonly id: string;
    readonly integrations: readonly AgentIntegrationClass[];
    readonly projectBasePath: string;
  }) {
    this.id = options.id;
    this.#projects = new LocalExecutionProjectService(options.projectBasePath, (callOptions) => this.#assertAvailable(callOptions));
    const instanceId = options.instanceId ?? crypto.randomUUID();
    this.#registry = new IntegrationRegistry({
      integrations: options.integrations,
      hostFactory: new IntegrationHostFactory({ ...options, nodeId: options.id, instanceId }),
    });
    this.#info = Object.freeze({
      nodeId: options.id,
      instanceId,
      projectBasePath: this.#projects.projectBasePath,
      integrationIds: Object.freeze(this.#registry.list().map((integration) => integration.descriptor.id)),
      services: Object.freeze({ agents: true, processes: false, files: false, git: false, terminals: false }),
    });
  }

  get availability(): NodeAvailability { return this.#disposed ? 'disposed' : 'ready'; }

  async getInfo(options?: NodeCallOptions): Promise<ExecutionNodeInfo> {
    this.#assertAvailable(options);
    return this.#info;
  }

  async getAgentIntegration(agentId: string, options?: NodeCallOptions) {
    this.#assertAvailable(options);
    return this.#registry.require(agentId);
  }

  async getProcessService(): Promise<never> { throw unavailableService('processes'); }
  async getProjectService(options?: NodeCallOptions) {
    this.#assertAvailable(options);
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
    if (this.#disposed) return;
    this.#disposed = true;
    for (const listener of this.#listeners) listener('disposed');
    this.#listeners.clear();
    await Promise.allSettled(this.#registry.list().map((integration) => integration.lifecycle.stop()));
  }

  #assertAvailable(options?: NodeCallOptions): void {
    options?.signal?.throwIfAborted();
    if (this.#disposed) throw new AgentCallError('not-dispatched', 'Execution node is disposed');
  }
}

export function unavailableService(service: string): AgentCallError {
  return new AgentCallError('not-dispatched', `Execution-node ${service} service is unavailable`, 'OPERATION_UNSUPPORTED');
}
