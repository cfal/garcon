// Shared provider types. Defines the typed contracts for session
// lifecycle operations so that callers and providers share a single
// source of truth for required fields.

import type { AgentCommandImage, PermissionMode } from '../../common/ws-requests.js';
import type { ProviderId } from '../../common/providers.js';

export type { AgentCommandImage, PermissionMode };
export type ProviderName = ProviderId;

// Core execution context shared by all session operations.
export interface ProviderExecutionConfig {
  chatId: string;
  projectPath: string;
  model: string;
  permissionMode: PermissionMode;
  thinkingMode: string;
  modelReasoningEffort?: string;
}

// Request to start a new provider session.
export interface StartSessionRequest extends ProviderExecutionConfig {
  command: string;
  images?: AgentCommandImage[];
}

// Claude start requires a pre-generated providerSessionId.
export interface ClaudeStartSessionRequest extends StartSessionRequest {
  providerSessionId: string;
}

// Request to resume an existing session with a new user turn.
export interface ResumeTurnRequest extends ProviderExecutionConfig {
  providerSessionId: string;
  command: string;
  images?: AgentCommandImage[];
}

// One-shot query with relaxed requirements (no session lifecycle).
export interface SingleQueryRequest {
  prompt: string;
  model?: string;
  permissionMode?: PermissionMode;
  thinkingMode?: string;
  modelReasoningEffort?: string;
  cwd?: string;
  projectPath?: string;
}

// Typed view of a chat registry entry used by providers.
export interface ProviderChatEntry {
  provider: ProviderName;
  projectPath: string;
  providerSessionId?: string | null;
  model?: string;
  permissionMode?: PermissionMode;
  thinkingMode?: string;
  nativePath?: string | null;
}

// Public API request for ProviderRegistry.startSession().
export interface StartProviderSessionRequest {
  chatId: string;
  command: string;
  projectPath: string;
  images?: AgentCommandImage[];
  model?: string;
  permissionMode?: PermissionMode;
  thinkingMode?: string;
  modelReasoningEffort?: string;
}

// Public API request for ProviderRegistry.runProviderTurn().
export interface RunProviderTurnRequest {
  chatId: string;
  command: string;
  images?: AgentCommandImage[];
  model?: string;
  permissionMode?: PermissionMode;
  thinkingMode?: string;
  modelReasoningEffort?: string;
}
