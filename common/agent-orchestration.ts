// Shared contracts for Garcon-owned child-agent orchestration.

import type {
  AmpAgentMode,
  ClaudeThinkingMode,
  PermissionMode,
  ThinkingMode,
} from './chat-modes.js';

export type AgentOrchestrationChildStatus =
  | 'starting'
  | 'running'
  | 'completed'
  | 'failed'
  | 'aborted';

export interface AgentOrchestrationTaskRequest {
  taskName: string;
  prompt: string;
  role?: string;
  model?: string;
  permissionMode?: PermissionMode;
  thinkingMode?: ThinkingMode;
  claudeThinkingMode?: ClaudeThinkingMode;
  ampAgentMode?: AmpAgentMode;
}

export interface AgentOrchestrationSpawnRequest {
  parentChatId: string;
  tasks: AgentOrchestrationTaskRequest[];
  concurrencyLimit?: number;
}

export interface AgentOrchestrationChild {
  id: string;
  parentChatId: string;
  childChatId: string;
  taskName: string;
  prompt: string;
  role?: string;
  status: AgentOrchestrationChildStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  agentId?: string;
  agentSessionId?: string | null;
  nativePath?: string | null;
  model?: string | null;
  error?: string;
  resultPreview?: string;
}

export interface AgentOrchestration {
  id: string;
  parentChatId: string;
  createdAt: string;
  updatedAt: string;
  status: AgentOrchestrationChildStatus;
  concurrencyLimit: number;
  children: AgentOrchestrationChild[];
}

export interface AgentOrchestrationWaitRequest {
  orchestrationId: string;
  childIds?: string[];
  timeoutMs?: number;
}

export interface AgentOrchestrationAbortRequest {
  orchestrationId: string;
  childIds?: string[];
}

export function isFinalOrchestrationStatus(status: AgentOrchestrationChildStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'aborted';
}
