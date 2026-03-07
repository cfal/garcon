// Shared provider types. Defines the typed contracts for session
// lifecycle operations so that callers and providers share a single
// source of truth for required fields.

import type { PermissionMode, ThinkingMode } from '../../common/chat-modes.js';
import type { AgentCommandImage } from '../../common/ws-requests.js';
import type { ProviderId } from '../../common/providers.js';

export type { AgentCommandImage, PermissionMode, ThinkingMode };
export type ProviderName = ProviderId;

// Persisted chat execution state read from the registry.
export interface PersistedChatExecutionConfig {
  projectPath?: string;
  model?: string;
  permissionMode?: PermissionMode;
  thinkingMode?: ThinkingMode;
}

// Core execution context shared by all session operations.
export interface ProviderExecutionConfig extends PersistedChatExecutionConfig {
  chatId: string;
  projectPath: string;
  model: string;
  permissionMode: PermissionMode;
  thinkingMode: ThinkingMode;
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
  thinkingMode?: ThinkingMode;
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
  thinkingMode?: ThinkingMode;
  nativePath?: string | null;
}

export interface RequiredChatExecutionConfig extends PersistedChatExecutionConfig {
  projectPath: string;
  model: string;
  permissionMode: PermissionMode;
  thinkingMode: ThinkingMode;
}

// Validates persisted execution settings before they reach providers or queue drain.
export function requireChatExecutionConfig(
  chatId: string,
  entry: PersistedChatExecutionConfig | null | undefined,
): RequiredChatExecutionConfig {
  if (!entry) {
    throw new Error(`Session not initialized: ${chatId}`);
  }
  if (!entry.projectPath) {
    throw new Error(`Chat ${chatId} is missing projectPath`);
  }
  if (!entry.model) {
    throw new Error(`Chat ${chatId} is missing model`);
  }
  if (!entry.permissionMode) {
    throw new Error(`Chat ${chatId} is missing permissionMode`);
  }
  if (!entry.thinkingMode) {
    throw new Error(`Chat ${chatId} is missing thinkingMode`);
  }

  return {
    projectPath: entry.projectPath,
    model: entry.model,
    permissionMode: entry.permissionMode,
    thinkingMode: entry.thinkingMode,
  };
}

// Public API request for ProviderRegistry.startSession().
export interface StartProviderSessionRequest {
  chatId: string;
  command: string;
  projectPath: string;
  images?: AgentCommandImage[];
  model?: string;
  permissionMode?: PermissionMode;
  thinkingMode?: ThinkingMode;
}

// Public API request for ProviderRegistry.runProviderTurn().
export interface RunProviderTurnRequest {
  chatId: string;
  command: string;
  images?: AgentCommandImage[];
  model?: string;
  permissionMode?: PermissionMode;
  thinkingMode?: ThinkingMode;
}

// Runtime-supplied turn fields forwarded through the queue and WS layers.
export type RunProviderTurnOptions = Omit<RunProviderTurnRequest, 'chatId' | 'command'>;
