import type { ChatMessage } from '../../../common/chat-types.js';
import type { CodexThreadItem } from './protocol.js';

export class CodexTurnMessageDeduper {
  #itemIds = new Set<string>();
  #renderedKeys = new Set<string>();

  recordItem(item: CodexThreadItem, messages: ChatMessage[]): void {
    this.#itemIds.add(item.id);
    for (const message of messages) {
      const key = renderedMessageKey(message);
      if (key) this.#renderedKeys.add(key);
    }
  }

  shouldEmitItem(item: CodexThreadItem, messages: ChatMessage[]): boolean {
    if (this.#itemIds.has(item.id)) return false;
    if (messages.length === 0) return false;
    return messages.some((message) => {
      const key = renderedMessageKey(message);
      return !key || !this.#renderedKeys.has(key);
    });
  }
}

function renderedMessageKey(message: ChatMessage): string | null {
  if ('toolId' in message && typeof message.toolId === 'string' && message.toolId) {
    return `${message.type}:tool:${message.toolId}`;
  }
  if ('content' in message && typeof message.content === 'string') {
    const content = message.content.trim();
    if (content) return `${message.type}:text:${content}`;
  }
  return null;
}
