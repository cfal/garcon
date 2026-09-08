import { ChatBoardService } from './service.js';
import { ChatBoardStore } from './store.js';
import { ChatTagMutationService } from '../chats/chat-tag-mutation-service.js';
import type { IChatRegistry } from '../chats/store.js';
import type { KeyedPromiseLock } from '../lib/keyed-lock.js';
import type { SettingsStore } from '../settings/store.js';

export async function initializeChatBoardService(workspaceDir: string): Promise<ChatBoardService> {
  const store = new ChatBoardStore(workspaceDir);
  await store.init();
  return new ChatBoardService({ store });
}

export async function initializeChatBoardRuntime(options: {
  workspaceDir: string;
  registry: IChatRegistry;
  chatMutationLock: KeyedPromiseLock;
  archiveState: Pick<SettingsStore, 'confirmArchiveState'>;
}) {
  const chatBoards = await initializeChatBoardService(options.workspaceDir);
  const chatTags = new ChatTagMutationService({
    registry: options.registry,
    chatMutationLock: options.chatMutationLock,
    boards: chatBoards,
    archiveState: options.archiveState,
  });
  return { chatBoards, chatTags, chatMutationLock: options.chatMutationLock };
}
