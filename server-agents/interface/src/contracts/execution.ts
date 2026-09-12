import type { PermissionMode, ThinkingMode } from '@garcon/common/chat-modes';
import type { AgentEndpointSelection } from '@garcon/common/agent-execution';
import type { AgentSettingsEnvelope } from '@garcon/common/agent-integration';
import type { AgentChatReference, AgentNativeSessionRef } from './transcript.js';

export interface AgentSessionConfiguration {
  readonly model: string;
  readonly permissionMode: PermissionMode;
  readonly thinkingMode: ThinkingMode;
  readonly settings: AgentSettingsEnvelope;
  readonly endpoint: AgentEndpointSelection | null;
}

/** Contains the credential captured with its endpoint; excluded from public and persisted configuration. */
export interface AgentAdmittedEndpoint {
  readonly selection: AgentEndpointSelection;
  readonly credential: string | null;
}

export interface AgentPreparedProviderConfiguration extends Omit<AgentSessionConfiguration, 'endpoint'> {
  readonly endpoint: AgentAdmittedEndpoint | null;
}

export interface AgentProjectPathUpdateRequest {
  readonly chat: AgentChatReference;
  readonly nextProjectPath: string;
  readonly signal: AbortSignal;
}

export interface AgentProjectPathUpdatePreparation {
  // `undefined` preserves the binding, `null` clears it, and a ref replaces it.
  readonly nativeSession?: AgentNativeSessionRef | null;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface AgentExecutionAdmission {
  readonly signal: AbortSignal;
  markStarted(): Promise<void>;
}

export interface AgentRunningSession {
  // Values are nonempty and unique within each runningSessions snapshot.
  readonly agentSessionId: string;
  // Provider-worded status for diagnostics surfaces only; never branch on it.
  readonly status: string | null;
  readonly startedAt: string | null;
}

export interface AgentSessionConfigurationUpdates {
  /** Captures native identity and configuration without mutation; only definite initial absence permits not-required. */
  prepare(request: AgentSessionConfigurationPrepareRequest): Promise<AgentSessionConfigurationPreparation>;
  /** Consumes the capture once and revalidates at native delivery; uncertain mutation must return unknown. */
  commit(target: AgentSessionConfigurationTarget, signal: AbortSignal): Promise<AgentSessionConfigurationCommitResult>;
  cancel(target: AgentSessionConfigurationTarget): void;
}

export interface AgentSessionConfigurationIdentity {
  readonly chatId: string;
  readonly agentSessionId: string;
  readonly nativeSession: AgentNativeSessionRef | null;
  readonly projectPath: string;
}

export interface AgentSessionConfigurationPrepareRequest {
  readonly expected: AgentSessionConfigurationIdentity;
  readonly previous: AgentSessionConfiguration;
  readonly next: AgentSessionConfiguration;
  readonly signal: AbortSignal;
}

export type AgentSessionConfigurationTarget = object;

export type AgentSessionConfigurationRejection = {
  readonly kind: 'rejected';
  readonly reason: 'target-conflict' | 'target-changed' | 'cancelled';
};

export type AgentSessionConfigurationPreparation =
  | { readonly kind: 'prepared'; readonly target: AgentSessionConfigurationTarget }
  | { readonly kind: 'not-required' }
  | AgentSessionConfigurationRejection;

export type AgentSessionConfigurationCommitResult =
  | { readonly kind: 'applied' }
  | { readonly kind: 'not-required' }
  | AgentSessionConfigurationRejection
  | { readonly kind: 'unknown' };

export interface AgentProjectPathUpdates {
  /** Transfers a confirmed native preparation to its caller even after cancellation. */
  prepare(request: AgentProjectPathUpdateRequest): Promise<AgentProjectPathUpdatePreparation | void>;
}
