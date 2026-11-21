// Restores in flight, by session. Concurrent callers share one restore instead
// of using a half-restored record, and release or shutdown cancels a restore so
// it cannot register a session afterwards.
export class AcpRestoreRegistry<T> {
  #pending = new Map<string, { readonly chatId: string; cancelled: boolean; promise?: Promise<T> }>();

  // Null when nothing is in flight, so callers add no await in the common case.
  inFlight(sessionId: string): Promise<unknown> | null {
    return this.#pending.get(sessionId)?.promise?.catch(() => {}) ?? null;
  }

  async run(sessionId: string, chatId: string, restore: (isCancelled: () => boolean) => Promise<T>): Promise<T> {
    const entry: { readonly chatId: string; cancelled: boolean; promise?: Promise<T> } = { chatId, cancelled: false };
    this.#pending.set(sessionId, entry);
    entry.promise = restore(() => entry.cancelled);
    try {
      return await entry.promise;
    } finally {
      if (this.#pending.get(sessionId) === entry) this.#pending.delete(sessionId);
    }
  }

  cancel(sessionId: string, chatId: string): void {
    const entry = this.#pending.get(sessionId);
    if (entry?.chatId === chatId) entry.cancelled = true;
  }

  cancelAll(): void {
    for (const entry of this.#pending.values()) entry.cancelled = true;
  }
}
