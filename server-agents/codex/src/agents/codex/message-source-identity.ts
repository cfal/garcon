import type { ChatMessage } from '@garcon/common/chat-types';
import type { NativeMessageSource } from '@garcon/server-agent-interface';

interface CodexMessageSourceInput {
  readonly turnId: string | null | undefined;
  readonly itemId: string | null | undefined;
  readonly message: ChatMessage;
  readonly fallbackOrdinal: number;
}

export function codexMessageSourceIdentity(
  input: CodexMessageSourceInput,
): NativeMessageSource | null {
  const turnId = nonEmptyString(input.turnId);
  if (!turnId) return null;

  const toolId = messageToolId(input.message);
  if (toolId) {
    return {
      entryId: `turn:${turnId}:tool:${toolId}`,
      withinSourceOrdinal: input.message.type === 'tool-result' ? 1 : 0,
    };
  }

  const itemId = nonEmptyString(input.itemId);
  return itemId
    ? {
        entryId: `turn:${turnId}:item:${itemId}`,
        withinSourceOrdinal: input.fallbackOrdinal,
      }
    : null;
}

function messageToolId(message: ChatMessage): string | null {
  return 'toolId' in message ? nonEmptyString(message.toolId) : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
