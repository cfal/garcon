export class ChatStreamFence {
  #epochs = new Map<string, number>();

  capture(chatId: string): number {
    return this.#epochs.get(chatId) ?? 0;
  }

  invalidate(chatId: string): number {
    const next = this.capture(chatId) + 1;
    this.#epochs.set(chatId, next);
    return next;
  }

  isCurrent(chatId: string, epoch: number): boolean {
    return this.capture(chatId) === epoch;
  }

  clear(chatId: string): void {
    this.#epochs.delete(chatId);
  }
}
