import type { PermissionDecisionPayload } from '@garcon/common/chat-command-contracts';
import type { PermissionMode, ThinkingMode } from '@garcon/common/chat-modes';
import type { RuntimeEventMetadata } from '@garcon/server-agent-common/shared/event-emitter-runtime';

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
  readonly clientRequestId?: string;
  readonly turnId?: string;
  readonly executionAdmission?: OpenCodeExecutionAdmission;
}

export interface OpenCodeStartRequest extends OpenCodeExecutionRequest {
  readonly command: string;
  readonly images?: readonly unknown[];
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

export function openCodeEventMetadata(
  request: Pick<OpenCodeExecutionRequest, 'clientRequestId' | 'turnId'>,
  commandType?: RuntimeEventMetadata['commandType'],
) {
  return Object.freeze({
    ...(request.clientRequestId ? { clientRequestId: request.clientRequestId } : {}),
    ...(commandType ? { commandType } : {}),
    ...(request.turnId ? { turnId: request.turnId } : {}),
  });
}
