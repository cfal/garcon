import type { ChatMessage } from '@garcon/common/chat-types';
import type { ToolUseChatMessage } from '@garcon/common/chat-types';
import type { PermissionDecisionPayload } from '@garcon/common/chat-command-contracts';
import type { AcpSessionUpdateNotification } from './protocol.js';

export interface AcpSessionUpdateContext {
  chatId: string;
  sessionId: string;
  timestamp: string;
}

export interface AcpCustomRequest {
  method: string;
  permissionOccurrenceId: string;
  params: unknown;
}

export interface AcpBlockingRequestToolUse {
  tool: ToolUseChatMessage;
  responseForDecision(decision: PermissionDecisionPayload): Record<string, unknown>;
  responseForCancellation(reason: 'cancelled' | 'session-complete' | 'aborted'): Record<string, unknown>;
}

export interface AcpEventConverter {
  beginTurn?(sessionId: string): void;
  fromSessionUpdate(
    notification: AcpSessionUpdateNotification,
    context: AcpSessionUpdateContext,
  ): ChatMessage[];
  permissionToolUse?(
    toolCall: Record<string, unknown>,
    context: AcpSessionUpdateContext,
  ): ToolUseChatMessage | null;
  customRequestToolUse?(
    request: AcpCustomRequest,
    context: AcpSessionUpdateContext,
  ): AcpBlockingRequestToolUse | null;
  endTurn?(sessionId: string, context: AcpSessionUpdateContext): ChatMessage[];
  // Returns and clears a failure the agent reported in-band before ending the turn normally.
  takeTurnFailure?(sessionId: string): string | null;
  // Drops per-session state once the runtime retires the session.
  releaseSession?(sessionId: string): void;
}

export function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

// Text of an ACP content block, a bare string, or a list of either.
export function acpContentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(acpContentText).join('');
  const raw = asObject(value);
  return asString(raw.text ?? raw.content ?? raw.delta) ?? '';
}
