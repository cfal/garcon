const TARGET_BACKGROUND_DUTY = 0.25;
const MIN_PAUSE_MS = 10;
const MAX_PAUSE_MS = 500;

export interface WorkerSchedulerOptions {
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
}

export class TranscriptSearchWorkerScheduler {
  readonly #now: () => number;
  readonly #sleep: (delayMs: number) => Promise<void>;
  #backgroundTail: Promise<void> = Promise.resolve();
  #wakePause: (() => void) | null = null;

  constructor(options: WorkerSchedulerOptions = {}) {
    this.#now = options.now ?? (() => performance.now());
    this.#sleep = options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  }

  runBackground<T>(work: (yieldAfterSlice: () => Promise<void>) => Promise<T>): Promise<T> {
    let resolveResult: (value: T | PromiseLike<T>) => void;
    let rejectResult: (error: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    this.#backgroundTail = this.#backgroundTail
      .catch(() => undefined)
      .then(async () => {
        let sliceStarted = this.#now();
        const yieldAfterSlice = async (): Promise<void> => {
          const activeMs = Math.max(0, this.#now() - sliceStarted);
          await this.#pauseForActiveTime(activeMs);
          sliceStarted = this.#now();
        };
        try {
          resolveResult(await work(yieldAfterSlice));
        } catch (error) {
          rejectResult(error);
        }
        await yieldAfterSlice();
      });
    return result;
  }

  wakeInteractive(): void {
    this.#wakePause?.();
  }

  async #pauseForActiveTime(activeMs: number): Promise<void> {
    let remainingMs = Math.max(MIN_PAUSE_MS, activeMs * (1 / TARGET_BACKGROUND_DUTY - 1));
    while (remainingMs > 0) {
      const pauseMs = Math.min(MAX_PAUSE_MS, remainingMs);
      await this.#interruptiblePause(pauseMs);
      remainingMs -= pauseMs;
      if (this.#wakePause === null && pauseMs < MAX_PAUSE_MS) break;
    }
  }

  async #interruptiblePause(delayMs: number): Promise<void> {
    let wake: (() => void) | null = null;
    const interrupted = new Promise<void>((resolve) => {
      wake = resolve;
      this.#wakePause = resolve;
    });
    await Promise.race([this.#sleep(delayMs), interrupted]);
    if (this.#wakePause === wake) this.#wakePause = null;
  }
}
