import type { AgentEndpointSelection } from '@garcon/common/agent-execution';
import type { AgentSettingsEnvelope } from '@garcon/common/agent-integration';
import type { PermissionMode, ThinkingMode } from '@garcon/common/chat-modes';
import type { JsonObject } from '@garcon/common/json';
import type { AgentExecutionAdmission } from './execution.js';
import type { AgentEstablishedSession } from './producer.js';
import type { AgentChatReference } from './transcript.js';

export interface AgentNativeForkRequest {
  readonly chatId: string;
  readonly projectPath: string;
  readonly model: string;
  readonly permissionMode: PermissionMode;
  readonly thinkingMode: ThinkingMode;
  readonly settings: AgentSettingsEnvelope;
  readonly endpoint: AgentEndpointSelection | null;
  readonly admission: AgentExecutionAdmission;
  readonly source: AgentChatReference;
  readonly providerMeta: JsonObject | null;
}

export type AgentNativeForkOutcome =
  | { readonly kind: 'materialized'; readonly session: AgentEstablishedSession }
  | { readonly kind: 'unmaterialized' };

export interface AgentNativeFork {
  fork(request: AgentNativeForkRequest): Promise<AgentNativeForkOutcome>;
  discard(session: AgentEstablishedSession, signal: AbortSignal): Promise<void>;
}
