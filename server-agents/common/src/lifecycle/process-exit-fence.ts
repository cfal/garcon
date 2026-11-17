export interface TerminationTimings {
  readonly termMs: number;
  readonly killMs: number;
}

export interface TerminatingProcess {
  readonly exited: Promise<number>;
  kill(signal?: number | NodeJS.Signals): void;
}

const DEFAULT_TIMINGS: TerminationTimings = { termMs: 5_000, killMs: 5_000 };

async function exitedWithin(exited: Promise<boolean>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([exited, new Promise<false>(resolve => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

// A timed-out kill remains an admission fence until the direct child's exit is observed.
export class ProcessExitFence {
  readonly #pending = new Map<string, Set<Promise<boolean>>>();

  constructor(private readonly timings: TerminationTimings = DEFAULT_TIMINGS) {}

  assertClear(key: string): void {
    if (this.#pending.get(key)?.size) throw new Error('A previous process for this session has not exited');
  }

  terminate(key: string, process: TerminatingProcess, onExit: () => void): Promise<boolean> {
    const pending = this.#pending.get(key) ?? new Set<Promise<boolean>>();
    this.#pending.set(key, pending);
    const exited = process.exited.then(() => {
      onExit();
      pending.delete(attempt);
      if (!pending.size && this.#pending.get(key) === pending) this.#pending.delete(key);
      return true;
    }, () => false);
    const attempt = (async () => {
      try { process.kill('SIGTERM'); } catch { /* Exit observation, not signal delivery, releases admission. */ }
      if (await exitedWithin(exited, this.timings.termMs)) return true;
      try { process.kill('SIGKILL'); } catch { /* An unconfirmed exit remains fenced. */ }
      return exitedWithin(exited, this.timings.killMs);
    })();
    pending.add(attempt);
    return attempt;
  }

  async wait(key: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    for (;;) {
      const pending = this.#pending.get(key);
      if (!pending?.size) return;
      let settled = Promise.all(pending);
      let abort: (() => void) | undefined;
      try {
        if (signal) {
          const aborted = Promise.withResolvers<never>();
          abort = () => aborted.reject(signal.reason);
          signal.addEventListener('abort', abort, { once: true });
          settled = Promise.race([settled, aborted.promise]);
        }
        const outcomes = await settled;
        signal?.throwIfAborted();
        if (outcomes.includes(false)) throw new Error('A previous process for this session has not exited');
      } finally {
        if (abort) signal?.removeEventListener('abort', abort);
      }
    }
  }
}
