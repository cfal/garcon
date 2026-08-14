import type { NativeMessageSource } from '@garcon/server-agent-interface';

const ROLE_ORDINAL = {
  user: 0,
  assistant: 1,
} as const;

interface DirectMessageIdentity {
  readonly role: keyof typeof ROLE_ORDINAL;
  readonly turnId?: string;
}

// A direct turn writes its user and assistant rows under one turn ID, so the role
// supplies the within-turn order that keeps live and imported rows on the same key.
export function directMessageNativeSource(
  message: DirectMessageIdentity,
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
