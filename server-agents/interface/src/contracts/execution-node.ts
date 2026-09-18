import type { AgentIntegration } from './integration.js';
import type { NodeCallOptions } from './resources.js';
import type { NodePath } from '@garcon/common/node-path';
import type { ProjectResolution } from '@garcon/common/project-resolution';

export interface ExecutionProjectService {
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

export type NodeAvailability = 'ready' | 'reconnecting' | 'offline' | 'disposed';

export interface ExecutionNodeInfo {
  readonly nodeId: string;
  readonly instanceId: string;
  readonly integrationIds: readonly string[];
  readonly projectBasePath: NodePath;
  readonly services: {
    readonly agents: true;
    readonly processes: false;
    readonly files: false;
    readonly git: false;
    readonly terminals: false;
  };
}

export interface ExecutionNode {
  readonly id: string;
  readonly availability: NodeAvailability;
  getInfo(options?: NodeCallOptions): Promise<ExecutionNodeInfo>;
  getAgentIntegration(agentId: string, options?: NodeCallOptions): Promise<AgentIntegration>;
  getProjectService(options?: NodeCallOptions): Promise<ExecutionProjectService>;
  getProcessService(options?: NodeCallOptions): Promise<never>;
  getFilesService(options?: NodeCallOptions): Promise<never>;
  getGitService(options?: NodeCallOptions): Promise<never>;
  getTerminalService(options?: NodeCallOptions): Promise<never>;
  onAvailabilityChanged(listener: (value: NodeAvailability) => void): () => void;
  dispose(): Promise<void>;
}
