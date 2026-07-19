import type { AgentAttachment } from '@garcon/common/agent-execution';
import type { PermissionMode, ThinkingMode } from '@garcon/common/chat-modes';
import type { AgentOperationIdentity } from '@garcon/server-agent-interface';
import type { RuntimeEventMetadata } from '@garcon/server-agent-common/shared/event-emitter-runtime';

export interface AcpExecutionAdmission {
  readonly signal: AbortSignal;
  markStarted(): void;
}

export interface AcpExecutionRequest {
  readonly chatId: string;
  readonly projectPath: string;
  readonly model: string;
  readonly permissionMode: PermissionMode;
  readonly thinkingMode: ThinkingMode;
  readonly clientRequestId?: string;
  readonly clientMessageId?: string;
  readonly turnId?: string;
  readonly executionAdmission?: AcpExecutionAdmission;
  readonly command: string;
  readonly images?: readonly AgentAttachment[];
  readonly envOverrides?: Readonly<Record<string, string>>;
  readonly onAbortable?: () => void;
}

export type AcpStartRequest = AcpExecutionRequest;

export interface AcpResumeRequest extends AcpExecutionRequest {
  readonly agentSessionId: string;
  readonly nativePath?: string | null;
}

export interface AcpStartedSession {
  readonly agentSessionId: string;
  readonly nativePath: string | null;
}

export interface AcpSessionSettingsPatch {
  readonly permissionMode?: PermissionMode;
  readonly thinkingMode?: ThinkingMode;
  readonly model?: string;
}

export interface AcpProjectPathUpdateRequest {
  readonly chatId: string;
  readonly agentSessionId: string | null;
  readonly previousProjectPath: string;
  readonly nextProjectPath: string;
  readonly nativePath: string | null;
}

export function assertAcpExecutionOpen(
  request: { readonly executionAdmission?: AcpExecutionAdmission },
): void {
  request.executionAdmission?.signal.throwIfAborted();
}

export function markAcpExecutionStarted(
  request: { readonly executionAdmission?: AcpExecutionAdmission },
): void {
  assertAcpExecutionOpen(request);
  request.executionAdmission?.markStarted();
}

export function acpEventMetadata(
  request: Pick<AcpExecutionRequest, 'clientRequestId' | 'turnId'>,
  commandType?: AgentOperationIdentity['commandType'],
): RuntimeEventMetadata {
  return Object.freeze({
    ...(request.clientRequestId ? { clientRequestId: request.clientRequestId } : {}),
    ...(commandType ? { commandType } : {}),
    ...(request.turnId ? { turnId: request.turnId } : {}),
  });
}
