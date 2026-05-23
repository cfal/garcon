// Shared agent types. Defines the typed contracts for session
// lifecycle operations so that callers and agents share a single
// source of truth for required fields.

import {
  normalizeAmpAgentMode,
  normalizeClaudeThinkingMode,
  normalizePermissionMode,
  normalizeThinkingMode,
  type AmpAgentMode,
  type ClaudeThinkingMode,
  type PermissionMode,
  type ThinkingMode,
} from "../../common/chat-modes.js";
import type { AgentCommandImage } from "../../common/ws-requests.js";
import type { AgentId } from "../../common/agents.js";
import type { ApiProtocol } from "../../common/api-providers.js";

export type { AgentCommandImage, AmpAgentMode, ClaudeThinkingMode, PermissionMode, ThinkingMode };
export type AgentName = AgentId;

export type CodexConfigValue = string | number | boolean | CodexConfigValue[] | { [key: string]: CodexConfigValue };
export type CodexConfigObject = { [key: string]: CodexConfigValue };

export interface CodexProviderConfig {
  config: CodexConfigObject;
  env?: Record<string, string>;
}

// Persisted chat execution state read from the registry.
export interface PersistedChatExecutionConfig {
  projectPath?: string;
  model?: string;
  permissionMode?: PermissionMode;
  thinkingMode?: ThinkingMode;
  claudeThinkingMode?: ClaudeThinkingMode;
  ampAgentMode?: AmpAgentMode;
}

// Core execution context shared by all session operations.
export interface AgentExecutionConfig extends PersistedChatExecutionConfig {
  chatId: string;
  projectPath: string;
  model: string;
  permissionMode: PermissionMode;
  thinkingMode: ThinkingMode;
  apiProviderId?: string | null;
  modelEndpointId?: string | null;
  modelProtocol?: ApiProtocol | null;
  clientRequestId?: string;
  turnId?: string;
}

export interface AgentEventMetadata {
  upstreamRequestId?: string;
}

// Request to start a new agent session.
export interface StartSessionRequest extends AgentExecutionConfig {
  command: string;
  images?: AgentCommandImage[];
  envOverrides?: Record<string, string>;
  codexConfig?: CodexProviderConfig;
}

export interface StartedAgentSession {
  agentSessionId: string;
  nativePath: string | null;
}

// Claude start requires a pre-generated agentSessionId.
export interface ClaudeStartSessionRequest extends StartSessionRequest {
  agentSessionId: string;
}

// Request to resume an existing session with a new user turn.
export interface ResumeTurnRequest extends AgentExecutionConfig {
  agentSessionId: string;
  command: string;
  images?: AgentCommandImage[];
  envOverrides?: Record<string, string>;
  codexConfig?: CodexProviderConfig;
  nativePath?: string | null;
}

// One-shot query with relaxed requirements (no session lifecycle).
export interface SingleQueryRequest {
  prompt: string;
  model?: string;
  permissionMode?: PermissionMode;
  thinkingMode?: ThinkingMode;
  claudeThinkingMode?: ClaudeThinkingMode;
  cwd?: string;
  projectPath?: string;
}

// Typed view of a chat registry entry used by agents.
export interface AgentChatEntry {
  agentId: AgentName;
  projectPath: string;
  agentSessionId?: string | null;
  model?: string;
  apiProviderId?: string | null;
  modelEndpointId?: string | null;
  modelProtocol?: ApiProtocol | null;
  permissionMode?: PermissionMode;
  thinkingMode?: ThinkingMode;
  claudeThinkingMode?: ClaudeThinkingMode;
  ampAgentMode?: AmpAgentMode;
  nativePath?: string | null;
}

export interface RequiredChatExecutionConfig extends PersistedChatExecutionConfig {
  projectPath: string;
  model: string;
  permissionMode: PermissionMode;
  thinkingMode: ThinkingMode;
  claudeThinkingMode: ClaudeThinkingMode;
  ampAgentMode: AmpAgentMode;
}

// Validates persisted execution settings before they reach agents or queue drain.
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

  return {
    projectPath: entry.projectPath,
    model: entry.model,
    permissionMode: normalizePermissionMode(entry.permissionMode),
    thinkingMode: normalizeThinkingMode(entry.thinkingMode),
    claudeThinkingMode: normalizeClaudeThinkingMode(entry.claudeThinkingMode),
    ampAgentMode: normalizeAmpAgentMode(entry.ampAgentMode),
  };
}

// Public API request for AgentRegistry.startSession().
export interface StartAgentSessionRequest {
  chatId: string;
  command: string;
  projectPath: string;
  images?: AgentCommandImage[];
  model?: string;
  permissionMode?: PermissionMode;
  thinkingMode?: ThinkingMode;
  claudeThinkingMode?: ClaudeThinkingMode;
  ampAgentMode?: AmpAgentMode;
}

// Public API request for AgentRegistry.runAgentTurn().
export interface RunAgentTurnRequest {
  chatId: string;
  command: string;
  images?: AgentCommandImage[];
  model?: string;
  apiProviderId?: string | null;
  modelEndpointId?: string | null;
  modelProtocol?: ApiProtocol | null;
  permissionMode?: PermissionMode;
  thinkingMode?: ThinkingMode;
  claudeThinkingMode?: ClaudeThinkingMode;
  ampAgentMode?: AmpAgentMode;
}

// Runtime-supplied turn fields forwarded through the queue and WS layers.
export type RunAgentTurnOptions = Omit<RunAgentTurnRequest, 'chatId' | 'command'> & {
  clientRequestId?: string;
  clientMessageId?: string;
  turnId?: string;
};
