import type {
  AgentAttachment,
  AgentEndpointSelection,
} from '@garcon/common/agent-execution';
import type { PermissionMode, ThinkingMode } from '@garcon/common/chat-modes';
import type { AgentNativeSessionRef } from '@garcon/server-agent-interface';
import type { AgentRuntimeOperation } from '../execution/runtime-events.js';

export interface DirectEndpointRuntime {
  readonly selection: AgentEndpointSelection;
  readonly credential: string | null;
}

export interface DirectExecutionAdmission {
  readonly signal: AbortSignal;
  markStarted(): Promise<void>;
}

export interface DirectExecutionRequest {
  readonly chatId: string;
  readonly projectPath: string;
  readonly model: string;
  readonly permissionMode: PermissionMode;
  readonly thinkingMode: ThinkingMode;
  readonly executionAdmission?: DirectExecutionAdmission;
  readonly command: string;
  readonly images?: readonly AgentAttachment[];
  readonly endpoint: DirectEndpointRuntime;
  readonly operation: AgentRuntimeOperation;
}

export interface DirectStartRequest extends DirectExecutionRequest {
  readonly onSessionActivated?: (session: DirectStartedSession) => void;
}

export interface DirectResumeRequest extends DirectExecutionRequest {
  readonly agentSessionId: string;
  readonly nativeSession: AgentNativeSessionRef | null;
}

export interface DirectStartedSession {
  readonly agentSessionId: string;
  readonly nativeSession: AgentNativeSessionRef;
}

export function assertDirectExecutionOpen(
  request: { readonly executionAdmission?: DirectExecutionAdmission },
): void {
  request.executionAdmission?.signal.throwIfAborted();
}

export async function markDirectExecutionStarted(
  request: { readonly executionAdmission?: DirectExecutionAdmission },
): Promise<void> {
  assertDirectExecutionOpen(request);
  await request.executionAdmission?.markStarted();
}
