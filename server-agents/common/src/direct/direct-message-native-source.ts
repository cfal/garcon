import type { NativeMessageSource } from '@garcon/server-agent-interface';
import type { DirectConversationMessage } from './session-store.js';

const ROLE_ORDINAL = {
  user: 0,
  assistant: 1,
} as const;

export function directMessageNativeSource(
  message: Pick<DirectConversationMessage, 'role' | 'turnId'>,
  lineNumber?: number,
): NativeMessageSource {
  const turnId = message.turnId?.trim();
  return {
    ...(lineNumber === undefined ? {} : { lineNumber }),
    ...(turnId
      ? {
          entryId: `direct-turn:${turnId}`,
          withinSourceOrdinal: ROLE_ORDINAL[message.role],
        }
      : {}),
  };
}
