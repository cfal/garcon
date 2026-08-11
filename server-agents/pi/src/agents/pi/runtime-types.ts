import type { AgentAttachment } from '@garcon/common/agent-execution';
import type { PermissionMode, ThinkingMode } from '@garcon/common/chat-modes';
import type { AgentTurnReceiptOwner } from '@garcon/server-agent-interface';
import type { RuntimeEventMetadata } from '@garcon/server-agent-common/shared/event-emitter-runtime';

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
  readonly clientRequestId?: string;
  readonly turnId?: string;
  readonly executionAdmission?: PiExecutionAdmission;
  readonly command: string;
  readonly images?: readonly AgentAttachment[];
  readonly envOverrides?: Readonly<Record<string, string>>;
  readonly onAbortable?: () => void;
}

export type PiStartRequest = PiExecutionRequest;

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

export function piEventMetadata(
  request: Pick<PiExecutionRequest, 'clientRequestId' | 'turnId'>,
  commandType?: AgentTurnReceiptOwner['commandType'],
): RuntimeEventMetadata {
  return Object.freeze({
    ...(request.clientRequestId ? { clientRequestId: request.clientRequestId } : {}),
    ...(commandType ? { commandType } : {}),
    ...(request.turnId ? { turnId: request.turnId } : {}),
  });
}
