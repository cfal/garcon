import type { ChatMessage } from '../../../common/chat-types.js';
import type { ToolUseChatMessage } from '../../../common/chat-types.js';
import type { PermissionDecisionPayload } from '../../../common/chat-command-contracts.js';
import type { AcpJsonRpcId } from '../../acp/protocol.js';
import type { AcpSessionUpdateNotification } from '../../acp/protocol.js';

export interface AcpSessionUpdateContext {
  chatId: string;
  sessionId: string;
  timestamp: string;
}

export interface AcpCustomRequest {
  method: string;
  requestId: AcpJsonRpcId;
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
}

export function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
