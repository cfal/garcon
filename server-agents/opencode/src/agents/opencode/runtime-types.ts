import type { AgentAttachment } from '@garcon/common/agent-execution';
import type { PermissionDecisionPayload } from '@garcon/common/chat-command-contracts';
import type { PermissionMode, ThinkingMode } from '@garcon/common/chat-modes';
import type { AgentRuntimeOperation } from '@garcon/server-agent-common/execution/runtime-events';

export interface OpenCodeExecutionAdmission {
  readonly signal: AbortSignal;
  markStarted(): Promise<void>;
}

export interface OpenCodeExecutionRequest {
  readonly chatId: string;
  readonly projectPath: string;
  readonly model: string;
  readonly permissionMode: PermissionMode;
  readonly thinkingMode: ThinkingMode;
  readonly executionAdmission?: OpenCodeExecutionAdmission;
  readonly operation: AgentRuntimeOperation;
}

export interface OpenCodeStartRequest extends OpenCodeExecutionRequest {
  readonly command: string;
  readonly images?: readonly AgentAttachment[];
  readonly onSessionActivated?: (agentSessionId: string) => void;
}

export interface OpenCodeResumeRequest extends OpenCodeStartRequest {
  readonly agentSessionId: string;
}

export interface OpenCodeSessionSettingsPatch {
  readonly permissionMode?: PermissionMode;
  readonly thinkingMode?: ThinkingMode;
  readonly model?: string;
}

export type OpenCodePermissionDecision = PermissionDecisionPayload;

export function assertOpenCodeExecutionOpen(
  request: { readonly executionAdmission?: OpenCodeExecutionAdmission },
): void {
  request.executionAdmission?.signal.throwIfAborted();
}

export async function markOpenCodeExecutionStarted(
  request: { readonly executionAdmission?: OpenCodeExecutionAdmission },
): Promise<void> {
  assertOpenCodeExecutionOpen(request);
  await request.executionAdmission?.markStarted();
}
