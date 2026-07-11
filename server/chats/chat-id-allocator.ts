import { chatIdFromEpochMicroseconds, type ChatId } from '../../common/chat-id.js';
import type { IChatRegistry } from './store.js';

const MAX_ALLOCATION_ATTEMPTS = 10_000;

export class ChatIdAllocator {
  #lastIssued = 0n;

  constructor(
    private readonly chats: Pick<IChatRegistry, 'getChat'>,
    private readonly now: () => number = Date.now,
  ) {}

  allocate(): ChatId {
    const observed = BigInt(Math.trunc(this.now())) * 1_000n;
    let candidate = observed > this.#lastIssued ? observed : this.#lastIssued + 1n;

    for (let attempt = 0; attempt < MAX_ALLOCATION_ATTEMPTS; attempt += 1) {
      const chatId = chatIdFromEpochMicroseconds(candidate);
      if (!this.chats.getChat(chatId)) {
        this.#lastIssued = candidate;
        return chatId;
      }
      candidate += 1n;
    }
    throw new Error('Could not allocate a unique chat ID');
  }
}
