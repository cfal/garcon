import type { AgentAttachment } from '@garcon/common/agent-execution';
import type { PermissionMode, ThinkingMode } from '@garcon/common/chat-modes';
import type { RuntimeEventMetadata } from '@garcon/server-agent-common/shared/event-emitter-runtime';
import type { CodexGoalCommand } from './goal-command.js';

export type CodexConfigValue =
  | string
  | number
  | boolean
  | CodexConfigValue[]
  | { [key: string]: CodexConfigValue };

export type CodexConfigObject = { [key: string]: CodexConfigValue };

export interface CodexProviderConfig {
  readonly config: CodexConfigObject;
  readonly env?: Record<string, string>;
}

export interface CodexExecutionAdmission {
  readonly signal: AbortSignal;
  markStarted(): Promise<void>;
}

export interface CodexExecutionRequest {
  readonly chatId: string;
  readonly projectPath: string;
  readonly model: string;
  readonly permissionMode: PermissionMode;
  readonly thinkingMode: ThinkingMode;
  readonly clientRequestId?: string;
  readonly clientMessageId?: string;
  readonly turnId?: string;
  readonly executionAdmission?: CodexExecutionAdmission;
  readonly command: string;
  readonly codexGoalCommand?: CodexGoalCommand;
  readonly images?: readonly AgentAttachment[];
  readonly envOverrides?: Record<string, string>;
  readonly codexConfig?: CodexProviderConfig;
}

export interface CodexStartRequest extends CodexExecutionRequest {
  readonly codexSeedContext?: string;
  // Invoked as soon as the thread is activated, before the first turn runs.
  // A blocking runtime can settle the whole turn inside startSession, so the
  // caller needs the session identity ahead of that resolution.
  readonly onSessionActivated?: (session: CodexStartedSession) => void;
}

export interface CodexResumeRequest extends CodexExecutionRequest {
  readonly agentSessionId: string;
  readonly nativePath?: string | null;
}

export interface CodexStartedSession {
  readonly agentSessionId: string;
  readonly nativePath: string | null;
}

export interface CodexChatEntry {
  readonly projectPath: string;
  readonly agentSessionId?: string | null;
  readonly model?: string;
  readonly nativePath?: string | null;
}

export interface CodexForkSessionRequest {
  readonly sourceSession: CodexChatEntry;
  readonly envOverrides?: Record<string, string>;
  readonly codexConfig?: CodexProviderConfig;
}


export function assertCodexExecutionOpen(
  request: { readonly executionAdmission?: CodexExecutionAdmission },
): void {
  request.executionAdmission?.signal.throwIfAborted();
}

export async function markCodexExecutionStarted(
  request: { readonly executionAdmission?: CodexExecutionAdmission },
): Promise<void> {
  assertCodexExecutionOpen(request);
  await request.executionAdmission?.markStarted();
}

export function codexEventMetadata(
  request: Pick<CodexExecutionRequest, 'clientRequestId' | 'turnId'>,
  commandType?: RuntimeEventMetadata['commandType'],
): RuntimeEventMetadata {
  return Object.freeze({
    ...(request.clientRequestId ? { clientRequestId: request.clientRequestId } : {}),
    ...(commandType ? { commandType } : {}),
    ...(request.turnId ? { turnId: request.turnId } : {}),
  });
}
