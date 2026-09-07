import { ChatBoardService } from './service.js';
import { ChatBoardStore } from './store.js';

export async function initializeChatBoardService(workspaceDir: string): Promise<ChatBoardService> {
  const store = new ChatBoardStore(workspaceDir);
  await store.init();
  return new ChatBoardService({ store });
}
