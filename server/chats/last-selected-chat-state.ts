export interface LastSelectedChatState {
  getLastSelectedChatId(): string | null;
  setLastSelectedChatId(chatId: string | null): void;
  clearIf(chatId: string): void;
}

export class InMemoryLastSelectedChatState implements LastSelectedChatState {
  #lastSelectedChatId: string | null = null;

  getLastSelectedChatId(): string | null {
    return this.#lastSelectedChatId;
  }

  setLastSelectedChatId(chatId: string | null): void {
    const normalized = typeof chatId === 'string' ? chatId.trim() : '';
    this.#lastSelectedChatId = normalized || null;
  }

  clearIf(chatId: string): void {
    if (this.#lastSelectedChatId === chatId) {
      this.#lastSelectedChatId = null;
    }
  }
}
