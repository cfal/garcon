import type { AgentAttachment } from '@garcon/common/agent-execution';
import type { CarriedContext } from '@garcon/common/transcript-seed';
import type { AgentExecutionAdmission, AgentRunningSession, AgentPreparedProviderConfiguration } from './execution.js';
import type { AgentEmissionSink } from './producer.js';
import type { AgentNativeSessionRef } from './transcript.js';

export type AgentExecutionHandle = object;

export interface AgentExecutionContextV5 extends AgentPreparedProviderConfiguration {
  readonly chatId: string;
  readonly projectPath: string;
  readonly runId: string;
  readonly output: AgentEmissionSink;
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
