import type { AgentIntegration } from './integration.js';
import type { ExecutorCallOptions } from './resources.js';
import type { ExecutionFilesService } from './files.js';
import type { ExecutionGitService, ExecutionGhService } from './git.js';
import type { ExecutionTerminalService } from './terminals.js';
import type { ExecutorPath } from '@garcon/common/executor-path';
import type { TicketProjectDefault } from '@garcon/common/tickets';
import type { ProjectResolution } from '@garcon/common/project-resolution';
import type { ApiProtocol, ModelDiscoveryKind, ApiProviderModelDiscoveryResponse } from '@garcon/common/api-providers';

export interface ApiProviderDiscoveryRequest {
  readonly protocol: ApiProtocol;
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly modelDiscovery: ModelDiscoveryKind;
}

export interface ExecutionProjectService {
  ticketProjectDefault(request: { readonly projectPath: ExecutorPath }, options?: ExecutorCallOptions): Promise<TicketProjectDefault>;
  inspect(request: {
    readonly projectPath: ExecutorPath;
    readonly includeGitRepository?: boolean;
  }, options?: ExecutorCallOptions): Promise<{
    readonly resolution: ProjectResolution;
    readonly isGitRepository?: boolean;
  }>;
  resolveFileMentions(request: {
    readonly projectPath: ExecutorPath;
    readonly command: string;
  }, options?: ExecutorCallOptions): Promise<string>;
}

export type ExecutorAvailability = 'ready' | 'offline' | 'disposed';

export interface ExecutorInfo {
  readonly executorId: string;
  readonly instanceId: string;
  readonly integrationIds: readonly string[];
  readonly projectBasePath: ExecutorPath;
  readonly services: {
    readonly agents: true;
    readonly processes: false;
    readonly files: boolean;
    readonly git: boolean;
    readonly gh: boolean;
    readonly terminals: boolean;
  };
}

export interface ExecutionRuntimeApi {
  readonly id: string;
  readonly availability: ExecutorAvailability;
  getInfo(options?: ExecutorCallOptions): Promise<ExecutorInfo>;
  getAgentIntegration(agentId: string, options?: ExecutorCallOptions): Promise<AgentIntegration>;
  getProjectService(options?: ExecutorCallOptions): Promise<ExecutionProjectService>;
  discoverApiProviderModels(request: ApiProviderDiscoveryRequest, options?: ExecutorCallOptions): Promise<ApiProviderModelDiscoveryResponse>;
  getProcessService(options?: ExecutorCallOptions): Promise<never>;
  getFilesService(options?: ExecutorCallOptions): Promise<ExecutionFilesService>;
  getGitService(options?: ExecutorCallOptions): Promise<ExecutionGitService>;
  getGhService(options?: ExecutorCallOptions): Promise<ExecutionGhService>;
  getTerminalService(options?: ExecutorCallOptions): Promise<ExecutionTerminalService>;
  onAvailabilityChanged(listener: (value: ExecutorAvailability) => void): () => void;
  dispose(): Promise<void>;
}
