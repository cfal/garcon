import type { PermissionDecisionPayload } from '@garcon/common/chat-command-contracts';
import type { PermissionMode, ThinkingMode } from '@garcon/common/chat-modes';
import type { ChatMessage } from '@garcon/common/chat-types';
import type { AgentAttachment, AgentEndpointSelection } from '@garcon/common/agent-execution';
import type { AgentSettingsEnvelope } from '@garcon/common/agent-integration';
import type { AgentIntegrationError } from '../errors.js';
import type { AgentChatReference, AgentNativeSessionRef } from './transcript.js';

export interface AgentExecution {
  start(request: AgentStartRequest): Promise<AgentStartedSession>;
  resume(request: AgentResumeRequest): Promise<void>;
  abort(agentSessionId: string): Promise<boolean>;
  isRunning(agentSessionId: string): boolean;
  runningSessions(): readonly AgentRunningSession[];
  submitActiveInput?(request: AgentActiveInput): Promise<boolean>;
  compact?(request: AgentCompactRequest): Promise<void>;
  applySessionConfiguration?(
    agentSessionId: string,
    configuration: AgentSessionConfiguration,
  ): Promise<void>;
  respondToPermission?(
    permissionRequestId: string,
    decision: PermissionDecisionPayload,
  ): Promise<void>;
  prepareProjectPathUpdate?(request: AgentProjectPathUpdateRequest): Promise<void>;
  subscribe(listener: (event: AgentExecutionEvent) => void): () => void;
}

export interface AgentExecutionContext {
  readonly chatId: string;
  readonly projectPath: string;
  readonly model: string;
  readonly permissionMode: PermissionMode;
  readonly thinkingMode: ThinkingMode;
  readonly settings: AgentSettingsEnvelope;
  readonly endpoint: AgentEndpointSelection | null;
  readonly operation: AgentOperationIdentity;
  readonly admission: AgentExecutionAdmission;
}

export interface AgentStartRequest extends AgentExecutionContext {
  readonly prompt: string;
  readonly attachments: readonly AgentAttachment[];
  readonly carryOver: readonly ChatMessage[];
}

export interface AgentResumeRequest extends AgentExecutionContext {
  readonly agentSessionId: string;
  readonly nativeSession: AgentNativeSessionRef | null;
  readonly prompt: string;
  readonly attachments: readonly AgentAttachment[];
}

export interface AgentActiveInput extends AgentResumeRequest {
  readonly beforeDelivery: (handoff: AgentActiveInputHandoff) => Promise<void>;
}

export interface AgentActiveInputHandoff {
  validate(): void;
  commit(): void;
}

export interface AgentCompactRequest extends AgentResumeRequest {
  readonly prompt: string;
}

export interface AgentSessionConfiguration {
  readonly model: string;
  readonly permissionMode: PermissionMode;
  readonly thinkingMode: ThinkingMode;
  readonly settings: AgentSettingsEnvelope;
  readonly endpoint: AgentEndpointSelection | null;
}

export interface AgentProjectPathUpdateRequest {
  readonly chat: AgentChatReference;
  readonly nextProjectPath: string;
  readonly signal: AbortSignal;
}

export interface AgentOperationIdentity {
  readonly commandType: 'chat-start' | 'agent-run' | 'fork-run' | 'agent-compact';
  readonly clientRequestId: string | null;
  readonly clientMessageId: string | null;
  readonly turnId: string;
}

export interface AgentExecutionAdmission {
  readonly signal: AbortSignal;
  markStarted(): void;
  markAbortable(): void;
}

export interface AgentStartedSession {
  readonly agentSessionId: string;
  readonly nativeSession: AgentNativeSessionRef | null;
}

export interface AgentRunningSession {
  readonly agentSessionId: string;
  readonly status: string | null;
  readonly startedAt: string | null;
}

export type AgentExecutionEvent =
  | { readonly type: 'messages'; readonly chatId: string; readonly messages: readonly ChatMessage[]; readonly operation: AgentOperationIdentity }
  | { readonly type: 'processing'; readonly chatId: string; readonly processing: boolean; readonly operation: AgentOperationIdentity }
  | { readonly type: 'session-created'; readonly chatId: string; readonly session: AgentStartedSession; readonly operation: AgentOperationIdentity }
  | { readonly type: 'finished'; readonly chatId: string; readonly exitCode: number; readonly operation: AgentOperationIdentity }
  | { readonly type: 'failed'; readonly chatId: string; readonly error: AgentIntegrationError; readonly operation: AgentOperationIdentity };
