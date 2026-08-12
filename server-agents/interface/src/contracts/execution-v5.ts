import type { AgentAttachment } from '@garcon/common/agent-execution';
import type { AgentSettingsEnvelope } from '@garcon/common/agent-integration';
import type { ChatMessage } from '@garcon/common/chat-types';
import type { CarriedContext } from '@garcon/common/transcript-seed';
import type { AgentExecutionAdmission, AgentRunningSession } from './execution.js';
import type { AgentProducerSink } from './producer.js';
import type { AgentNativeSessionRef } from './transcript.js';
import type { PermissionMode, ThinkingMode } from '@garcon/common/chat-modes';
import type { AgentEndpointSelection } from '@garcon/common/agent-execution';

export type AgentExecutionHandle = object;

export interface AgentExecutionContextV5 {
  readonly chatId: string;
  readonly projectPath: string;
  readonly model: string;
  readonly permissionMode: PermissionMode;
  readonly thinkingMode: ThinkingMode;
  readonly settings: AgentSettingsEnvelope;
  readonly endpoint: AgentEndpointSelection | null;
  readonly runId: string;
  readonly sink: AgentProducerSink;
  readonly priorContext: readonly ChatMessage[];
  readonly admission: AgentExecutionAdmission;
}

export interface AgentStartRequestV5 extends AgentExecutionContextV5 {
  readonly prompt: string;
  readonly attachments: readonly AgentAttachment[];
  readonly carriedContext: CarriedContext | null;
}

export interface AgentResumeRequestV5 extends AgentExecutionContextV5 {
  readonly agentSessionId: string;
  readonly nativeSession: AgentNativeSessionRef | null;
  readonly prompt: string;
  readonly attachments: readonly AgentAttachment[];
}

export interface AgentExecutionV5 {
  start(request: AgentStartRequestV5): Promise<AgentExecutionHandle>;
  resume(request: AgentResumeRequestV5): Promise<AgentExecutionHandle>;
  abort(handle: AgentExecutionHandle): Promise<boolean>;
  runningSessions(): readonly AgentRunningSession[];
}
