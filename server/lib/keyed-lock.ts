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

  async runExclusive<T>(key: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const previous = this.#locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chain = previous.catch(() => {}).then(() => current);
    this.#locks.set(key, chain);

    try {
      await waitForPrevious(previous, signal);
      signal?.throwIfAborted();
      return await fn();
    } finally {
      release();
      // A cancelled tail still fences new entrants until its predecessor releases.
      void chain.then(() => {
        if (this.#locks.get(key) === chain) this.#locks.delete(key);
      });
    }
  }
}

async function waitForPrevious(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return previous.catch(() => {});
  let abort: (() => void) | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      previous.then(resolve, resolve);
      if (signal.aborted) abort();
    });
  } finally {
    if (abort) signal.removeEventListener('abort', abort);
  }
}
