import type { ErrorMessage, ChatMessage } from '../../common/chat-types.js';
import type { ChatViewMessage } from '../../common/chat-view.js';

const MAX_RETAINED_NOTICES_PER_CHAT = 32;

export class ChatViewOperationalNotices {
  #messagesByChat = new Map<string, ErrorMessage[]>();

  retain(chatId: string, message: ErrorMessage): void {
    const messages = this.#messagesByChat.get(chatId) ?? [];
    messages.push(message);
    if (messages.length > MAX_RETAINED_NOTICES_PER_CHAT) messages.shift();
    this.#messagesByChat.set(chatId, messages);
  }

  delete(chatId: string): void {
    this.#messagesByChat.delete(chatId);
  }

  retained(chatId: string): readonly ErrorMessage[] {
    return this.#messagesByChat.get(chatId) ?? [];
  }

  missingFrom(chatId: string, entries: readonly ChatViewMessage[]): ErrorMessage[] {
    const present = new Set(entries.map((entry) => entry.message));
    return (this.#messagesByChat.get(chatId) ?? []).filter((message) => !present.has(message));
  }

  filterDuplicateAppends(
    chatId: string,
    entries: readonly ChatViewMessage[],
    messages: ChatMessage[],
  ): ChatMessage[] {
    const notices = new Set<ChatMessage>(this.#messagesByChat.get(chatId) ?? []);
    if (notices.size === 0) return messages;
    const present = new Set(entries.map((entry) => entry.message));
    return messages.filter((message) => !notices.has(message) || !present.has(message));
  }
}
