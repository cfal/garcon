import type { ChatMessage } from '../../../common/chat-types.js';
import type { ToolUseChatMessage } from '../../../common/chat-types.js';
import type { AcpSessionUpdateNotification } from '../../acp/protocol.js';

export interface AcpSessionUpdateContext {
  chatId: string;
  sessionId: string;
  timestamp: string;
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
