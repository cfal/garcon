import type { PermissionMode, ThinkingMode } from '@garcon/common/chat-modes';
import type { AgentEndpointSelection } from '@garcon/common/agent-execution';
import type { PermissionDecisionPayload } from '@garcon/common/chat-command-contracts';
import type { AgentSettingsEnvelope } from '@garcon/common/agent-integration';
import type { NativeSeedReceipt } from '@garcon/common/transcript-seed';
import type { AgentChatReference, AgentNativeSessionRef } from './transcript.js';

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

export interface AgentProjectPathUpdatePreparation {
  readonly nativeSession: AgentNativeSessionRef | null;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface AgentExecutionAdmission {
  readonly signal: AbortSignal;
  markStarted(): Promise<void>;
  markAbortable(): void;
}

export interface AgentStartedSession {
  readonly agentSessionId: string;
  readonly nativeSession: AgentNativeSessionRef | null;
  readonly nativeSeedReceipt: NativeSeedReceipt | null;
}

export interface AgentRunningSession {
  readonly agentSessionId: string;
  // Provider-worded status for diagnostics surfaces only; never branch on it.
  readonly status: string | null;
  readonly startedAt: string | null;
}

export interface AgentSessionConfigurationUpdates {
  apply(agentSessionId: string, configuration: AgentSessionConfiguration): Promise<void>;
}

export interface AgentPermissionDecisions {
  respond(permissionRequestId: string, decision: PermissionDecisionPayload): Promise<void>;
}

export interface AgentProjectPathUpdates {
  prepare(request: AgentProjectPathUpdateRequest): Promise<AgentProjectPathUpdatePreparation | void>;
}
