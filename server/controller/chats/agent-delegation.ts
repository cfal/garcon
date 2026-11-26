import type { ChatRegistryEntry } from './registry-contracts.js';

export function isDirectDelegatedChild(
  sourceChatId: string,
  targetChatId: string,
  target: Pick<ChatRegistryEntry, 'parentChatId' | 'nativeObservation'> | null,
): boolean {
  return target !== null && !target.nativeObservation && targetChatId !== sourceChatId
    && target.parentChatId === sourceChatId;
}
