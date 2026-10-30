// Runs at most one read per key at a time on an executor. Callers that ask
// while it runs, such as several browser tabs and the review scanner, share
// its outcome instead of starting another `gh` process. A caller that aborts
// leaves alone; the read itself is aborted only once every caller has left,
// and a read being aborted is no longer joinable.
//
// A joined read may have been dispatched shortly before the caller asked, so
// sharing trades at most one read's latency of freshness for the saved call.

interface SharedRead {
  readonly promise: Promise<unknown>;
  readonly controller: AbortController;
  callers: number;
}

export class GhSharedReads {
  readonly #reads = new Map<string, SharedRead>();

  get size(): number { return this.#reads.size; }

  run<T>(key: string, signal: AbortSignal | undefined, read: (signal: AbortSignal) => Promise<T>): Promise<T> {
    signal?.throwIfAborted();
    let entry = this.#reads.get(key);
    if (!entry) {
      const controller = new AbortController();
      const created: SharedRead = {
        controller,
        callers: 0,
        promise: Promise.resolve().then(() => read(controller.signal)).finally(() => {
          if (this.#reads.get(key) === created) this.#reads.delete(key);
        }),
      };
      // Callers observe the outcome; this keeps an abandoned read from reporting an unhandled rejection.
      created.promise.catch(() => {});
      this.#reads.set(key, created);
      entry = created;
    }
    const shared = entry;
    shared.callers += 1;
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const leave = (): void => {
        if (settled) return;
        settled = true;
        shared.callers -= 1;
        reject(signal!.reason);
        if (shared.callers > 0) return;
        if (this.#reads.get(key) === shared) this.#reads.delete(key);
        shared.controller.abort(signal!.reason);
      };
      signal?.addEventListener('abort', leave, { once: true });
      shared.promise.then(
        (value) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener('abort', leave);
          resolve(value as T);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener('abort', leave);
          reject(error);
        },
      );
    });
  }
}

export function sharedReadKey(...parts: (string | number)[]): string {
  return JSON.stringify(parts);
}
