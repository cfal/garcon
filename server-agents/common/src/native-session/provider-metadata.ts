import type { ChatMessage } from '@garcon/common/chat-types';
import type { JsonObject } from '@garcon/common/json';
import { getNativeMessageRevisionSource } from '@garcon/server-agent-interface';

export function providerMetadata(message: ChatMessage): JsonObject | null {
  const source = getNativeMessageRevisionSource(message);
  if (!source) return null;
  return {
    ...(source.entryId ? { entryId: source.entryId } : {}),
    ...(source.lineNumber !== undefined ? { lineNumber: source.lineNumber } : {}),
    ...(source.byteOffset !== undefined ? { byteOffset: source.byteOffset } : {}),
    ...(source.withinSourceOrdinal !== undefined
      ? { withinSourceOrdinal: source.withinSourceOrdinal }
      : {}),
  };
}
