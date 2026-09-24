import type { AgentIntegration } from './integration.js';
import type { NodeCallOptions } from './resources.js';
import type { ExecutionFilesService } from './files.js';
import type { ExecutionGitService, ExecutionGhService } from './git.js';
import type { ExecutionTerminalService } from './terminals.js';
import type { NodePath } from '@garcon/common/node-path';
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
  ticketProjectDefault(request: { readonly projectPath: NodePath }, options?: NodeCallOptions): Promise<TicketProjectDefault>;
  inspect(request: {
    readonly projectPath: NodePath;
    readonly includeGitRepository?: boolean;
  }, options?: NodeCallOptions): Promise<{
    readonly resolution: ProjectResolution;
    readonly isGitRepository?: boolean;
  }>;
  resolveFileMentions(request: {
    readonly projectPath: NodePath;
    readonly command: string;
  }, options?: NodeCallOptions): Promise<string>;
}

export type NodeAvailability = 'ready' | 'offline' | 'disposed';

export interface ExecutionNodeInfo {
  readonly nodeId: string;
  readonly instanceId: string;
  readonly integrationIds: readonly string[];
  readonly projectBasePath: NodePath;
  readonly services: {
    readonly agents: true;
    readonly processes: false;
    readonly files: boolean;
    readonly git: boolean;
    readonly gh: boolean;
    readonly terminals: boolean;
  };
}

export interface ExecutionNode {
  readonly id: string;
  readonly availability: NodeAvailability;
  getInfo(options?: NodeCallOptions): Promise<ExecutionNodeInfo>;
  getAgentIntegration(agentId: string, options?: NodeCallOptions): Promise<AgentIntegration>;
  getProjectService(options?: NodeCallOptions): Promise<ExecutionProjectService>;
  discoverApiProviderModels(request: ApiProviderDiscoveryRequest, options?: NodeCallOptions): Promise<ApiProviderModelDiscoveryResponse>;
  getProcessService(options?: NodeCallOptions): Promise<never>;
  getFilesService(options?: NodeCallOptions): Promise<ExecutionFilesService>;
  getGitService(options?: NodeCallOptions): Promise<ExecutionGitService>;
  getGhService(options?: NodeCallOptions): Promise<ExecutionGhService>;
  getTerminalService(options?: NodeCallOptions): Promise<ExecutionTerminalService>;
  onAvailabilityChanged(listener: (value: NodeAvailability) => void): () => void;
  dispose(): Promise<void>;
}
