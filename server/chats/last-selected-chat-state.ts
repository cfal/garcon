export interface LastSelectedChatState {
  getLastSelectedChatId(ownerUsername?: string | null): string | null;
  setLastSelectedChatId(chatId: string | null, ownerUsername?: string | null): void;
  clearIf(chatId: string, ownerUsername?: string | null): void;
}

export class InMemoryLastSelectedChatState implements LastSelectedChatState {
  #lastSelectedChatId: string | null = null;
  #lastSelectedByOwner = new Map<string, string | null>();

  #ownerKey(ownerUsername?: string | null): string | null {
    const normalized = ownerUsername?.trim();
    return normalized || null;
  }

  getLastSelectedChatId(ownerUsername?: string | null): string | null {
    const ownerKey = this.#ownerKey(ownerUsername);
    if (ownerKey) return this.#lastSelectedByOwner.get(ownerKey) ?? null;
    return this.#lastSelectedChatId;
  }

  setLastSelectedChatId(chatId: string | null, ownerUsername?: string | null): void {
    const normalized = typeof chatId === 'string' ? chatId.trim() : '';
    const value = normalized || null;
    const ownerKey = this.#ownerKey(ownerUsername);
    if (ownerKey) {
      this.#lastSelectedByOwner.set(ownerKey, value);
      return;
    }
    this.#lastSelectedChatId = value;
  }

  clearIf(chatId: string, ownerUsername?: string | null): void {
    const ownerKey = this.#ownerKey(ownerUsername);
    if (ownerKey) {
      if (this.#lastSelectedByOwner.get(ownerKey) === chatId) {
        this.#lastSelectedByOwner.delete(ownerKey);
      }
      return;
    }
    if (this.#lastSelectedChatId === chatId) {
      this.#lastSelectedChatId = null;
    }
  }
}
