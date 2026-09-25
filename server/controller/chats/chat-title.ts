import { extractFirstLine } from '../lib/text.js';
import type { IChatRegistry } from './store.js';

export interface DerivedChatNameInput {
  chatId: string;
  sourceChatId: string;
  registry: Pick<IChatRegistry, 'listChatIds'>;
  metadata: {
    getChatMetadata(chatId: string): { firstMessage?: string | null } | null;
  };
}

export function resolveChatTitle(
  name: string | null | undefined,
  firstMessage: string | null | undefined,
): string {
  return extractFirstLine(name || firstMessage || 'New Session') || 'New Session';
}
