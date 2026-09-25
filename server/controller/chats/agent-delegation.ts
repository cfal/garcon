import type { ChatRegistryEntry } from './store.js';

export function isDirectDelegatedChild(
  sourceChatId: string,
  targetChatId: string,
  target: Pick<ChatRegistryEntry, 'parentChat'> | null,
): boolean {
  return target !== null && targetChatId !== sourceChatId
    && target.parentChat?.relation === 'delegation'
    && target.parentChat.chatId === sourceChatId;
}
