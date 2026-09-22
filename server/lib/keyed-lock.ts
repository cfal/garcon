interface LockWaiter {
  acquire: () => void;
}

export class KeyedPromiseLock {
  #locks = new Map<string, Set<LockWaiter>>();

  runExclusiveMany<T>(keys: readonly string[], fn: () => Promise<T>): Promise<T> {
    const orderedKeys = [...new Set(keys)].sort();
    const acquire = (index: number): Promise<T> => {
      const key = orderedKeys[index];
      return key === undefined ? fn() : this.runExclusive(key, () => acquire(index + 1));
    };
    return acquire(0);
  }

  async runExclusive<T>(key: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    let waiters = this.#locks.get(key);
    if (waiters) {
      const queue = waiters;
      await new Promise<void>((resolve, reject) => {
        const cancelled = () => {
          queue.delete(waiter);
          reject(signal?.reason);
        };
        const waiter: LockWaiter = {
          acquire: () => {
            signal?.removeEventListener('abort', cancelled);
            resolve();
          },
        };
        queue.add(waiter);
        signal?.addEventListener('abort', cancelled, { once: true });
      });
    } else {
      waiters = new Set();
      this.#locks.set(key, waiters);
    }
    try {
      signal?.throwIfAborted();
      return await fn();
    } finally {
      const next = waiters.values().next().value;
      if (next) {
        waiters.delete(next);
        next.acquire();
      } else {
        this.#locks.delete(key);
      }
    }
  }
}
