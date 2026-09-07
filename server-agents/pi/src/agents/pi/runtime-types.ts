import type { AgentAttachment } from '@garcon/common/agent-execution';
import type { PermissionMode, ThinkingMode } from '@garcon/common/chat-modes';
import type { AgentRuntimeOperation } from '@garcon/server-agent-common/execution/runtime-events';

export interface PiExecutionAdmission {
  readonly signal: AbortSignal;
  markStarted(): Promise<void>;
}

export interface PiExecutionRequest {
  readonly chatId: string;
  readonly projectPath: string;
  readonly model: string;
  readonly permissionMode: PermissionMode;
  readonly thinkingMode: ThinkingMode;
  readonly operation: AgentRuntimeOperation;
  readonly executionAdmission?: PiExecutionAdmission;
  readonly command: string;
  readonly images?: readonly AgentAttachment[];
  readonly envOverrides?: Readonly<Record<string, string>>;
}

export interface PiStartRequest extends PiExecutionRequest {
  readonly onSessionActivated?: (session: PiStartedSession) => void;
}

export interface PiResumeRequest extends PiExecutionRequest {
  readonly agentSessionId: string;
  readonly nativePath?: string | null;
}

export interface PiStartedSession {
  readonly agentSessionId: string;
  readonly nativePath: string | null;
}

export function assertPiExecutionOpen(
  request: { readonly executionAdmission?: PiExecutionAdmission },
): void {
  request.executionAdmission?.signal.throwIfAborted();
}

export async function markPiExecutionStarted(
  request: { readonly executionAdmission?: PiExecutionAdmission },
): Promise<void> {
  assertPiExecutionOpen(request);
  await request.executionAdmission?.markStarted();
}
