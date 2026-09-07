import type { AgentAttachment } from '@garcon/common/agent-execution';
import type { PermissionMode, ThinkingMode } from '@garcon/common/chat-modes';
import type { AgentRuntimeOperation } from '@garcon/server-agent-common/execution/runtime-events';

export interface AcpExecutionAdmission {
  readonly signal: AbortSignal;
  markStarted(): Promise<void>;
}

export interface AcpExecutionRequest {
  readonly chatId: string;
  readonly projectPath: string;
  readonly model: string;
  readonly permissionMode: PermissionMode;
  readonly thinkingMode: ThinkingMode;
  readonly operation: AgentRuntimeOperation;
  readonly executionAdmission?: AcpExecutionAdmission;
  readonly command: string;
  readonly images?: readonly AgentAttachment[];
  readonly envOverrides?: Readonly<Record<string, string>>;
}

export interface AcpStartRequest extends AcpExecutionRequest {
  readonly onSessionActivated?: (session: AcpStartedSession) => void;
}

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

export async function markAcpExecutionStarted(
  request: { readonly executionAdmission?: AcpExecutionAdmission },
): Promise<void> {
  assertAcpExecutionOpen(request);
  await request.executionAdmission?.markStarted();
}
