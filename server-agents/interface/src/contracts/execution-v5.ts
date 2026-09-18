import type { AgentAttachment } from '@garcon/common/agent-execution';
import type { AgentSettingsEnvelope } from '@garcon/common/agent-integration';
import type { CarriedContext } from '@garcon/common/transcript-seed';
import type { AgentRunningSession } from './execution.js';
import type { AgentProducerBinding, AgentResourceRef, NodeCallOptions } from './resources.js';
import type { AgentNativeSessionRef } from './transcript.js';
import type { PermissionMode, ThinkingMode } from '@garcon/common/chat-modes';
import type { AgentEndpointSelection } from '@garcon/common/agent-execution';

export type AgentExecutionHandle = AgentResourceRef<'execution'>;

export interface AgentExecutionContextV5 {
  readonly chatId: string;
  readonly projectPath: string;
  readonly model: string;
  readonly permissionMode: PermissionMode;
  readonly thinkingMode: ThinkingMode;
  readonly settings: AgentSettingsEnvelope;
  readonly endpoint: AgentEndpointSelection | null;
  readonly runId: string;
  readonly producerBinding: AgentProducerBinding;
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
  start(request: AgentStartRequestV5, options?: NodeCallOptions): Promise<AgentExecutionHandle>;
  resume(request: AgentResumeRequestV5, options?: NodeCallOptions): Promise<AgentExecutionHandle>;
  abort(handle: AgentExecutionHandle, options?: NodeCallOptions): Promise<boolean>;
  runningSessions(options?: NodeCallOptions): Promise<readonly AgentRunningSession[]>;
}
