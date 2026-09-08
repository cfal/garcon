export class KeyedPromiseLock {
  #locks = new Map<string, Promise<void>>();

  runExclusiveMany<T>(keys: readonly string[], fn: () => Promise<T>): Promise<T> {
    const orderedKeys = [...new Set(keys)].sort();
    const acquire = (index: number): Promise<T> => {
      const key = orderedKeys[index];
      return key === undefined ? fn() : this.runExclusive(key, () => acquire(index + 1));
    };
    return acquire(0);
  }

  async runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chain = previous.catch(() => {}).then(() => current);
    this.#locks.set(key, chain);

    await previous.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (this.#locks.get(key) === chain) this.#locks.delete(key);
    }
  }
}
