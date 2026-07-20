import type { AgentEndpointSelection } from '@garcon/common/agent-execution';
import type { AgentSettingsEnvelope } from '@garcon/common/agent-integration';
import type { ApiProtocol } from '@garcon/common/api-providers';
import {
  normalizePermissionMode,
  normalizeThinkingMode,
  type PermissionMode,
  type ThinkingMode,
} from '@garcon/common/chat-modes';
import type { JsonObject } from '@garcon/common/json';
import type { AgentCommandImage } from '@garcon/common/ws-requests';
import type { AgentNativeSessionRef } from '@garcon/server-agent-interface';

export type { AgentCommandImage, PermissionMode, ThinkingMode };
export type AgentName = string;
export type AgentExecutionCommandType =
  | 'chat-start'
  | 'agent-run'
  | 'fork-run'
  | 'agent-compact';

export interface PersistedChatExecutionConfig {
  projectPath?: string;
  model?: string;
  permissionMode?: PermissionMode;
  thinkingMode?: ThinkingMode;
  agentSettingsById?: Record<string, AgentSettingsEnvelope>;
}

export interface AgentExecutionAdmission {
  readonly signal: AbortSignal;
  markStarted(): void;
}

export function assertExecutionAdmissionOpen(
  request: { executionAdmission?: AgentExecutionAdmission },
): void {
  request.executionAdmission?.signal.throwIfAborted();
}

export interface AgentSessionSettingsPatch {
  permissionMode?: PermissionMode;
  thinkingMode?: ThinkingMode;
  agentSettingsPatch?: JsonObject;
  model?: string;
  apiProviderId?: string | null;
  modelEndpointId?: string | null;
  modelProtocol?: ApiProtocol | null;
}

export class UnsupportedAgentSettingError extends Error {
  constructor(
    readonly agentId: string,
    readonly setting: keyof AgentSessionSettingsPatch,
  ) {
    super(`${agentId} does not support live setting: ${setting}`);
    this.name = 'UnsupportedAgentSettingError';
  }
}

export interface StartedAgentSession {
  agentSessionId: string;
  nativeSession: AgentNativeSessionRef | null;
}

export interface PrepareProjectPathUpdateRequest {
  chatId: string;
  agentSessionId: string | null;
  previousProjectPath: string;
  nextProjectPath: string;
  nativeSession: AgentNativeSessionRef | null;
}

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
  agentSettingsById?: Record<string, AgentSettingsEnvelope>;
  nativeSession?: AgentNativeSessionRef | null;
  agentOwnershipEpoch?: string;
}

export interface RequiredChatExecutionConfig extends PersistedChatExecutionConfig {
  projectPath: string;
  model: string;
  permissionMode: PermissionMode;
  thinkingMode: ThinkingMode;
  agentSettingsById: Record<string, AgentSettingsEnvelope>;
}

export function requireChatExecutionConfig(
  chatId: string,
  entry: PersistedChatExecutionConfig | null | undefined,
): RequiredChatExecutionConfig {
  if (!entry) throw new Error(`Session not initialized: ${chatId}`);
  if (!entry.projectPath) throw new Error(`Chat ${chatId} is missing projectPath`);
  if (!entry.model) throw new Error(`Chat ${chatId} is missing model`);

  return {
    projectPath: entry.projectPath,
    model: entry.model,
    permissionMode: normalizePermissionMode(entry.permissionMode),
    thinkingMode: normalizeThinkingMode(entry.thinkingMode),
    agentSettingsById: entry.agentSettingsById ?? {},
  };
}

export interface StartAgentSessionRequest {
  chatId: string;
  command: string;
  projectPath: string;
  images?: AgentCommandImage[];
  model?: string;
  permissionMode?: PermissionMode;
  thinkingMode?: ThinkingMode;
  agentSettings?: AgentSettingsEnvelope;
}

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
  agentSettings?: AgentSettingsEnvelope;
}

export type RunAgentTurnOptions = Omit<RunAgentTurnRequest, 'chatId' | 'command'> & {
  clientRequestId?: string;
  clientMessageId?: string;
  turnId?: string;
  commandType?: AgentExecutionCommandType;
  executionAdmission?: AgentExecutionAdmission;
  integrationEndpoint?: AgentEndpointSelection | null;
};
