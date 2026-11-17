import type { ChatRegistryEntry } from './registry-contracts.js';

export function isDirectDelegatedChild(
  sourceChatId: string,
  targetChatId: string,
  target: Pick<ChatRegistryEntry, 'parentChatId'> | null,
): boolean {
  return target !== null && targetChatId !== sourceChatId
    && target.parentChatId === sourceChatId;
}
