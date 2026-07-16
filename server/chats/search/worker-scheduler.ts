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

  runBackground<T>(work: () => Promise<T>): Promise<T> {
    let resolveResult: (value: T | PromiseLike<T>) => void;
    let rejectResult: (error: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    this.#backgroundTail = this.#backgroundTail
      .catch(() => undefined)
      .then(async () => {
        const started = this.#now();
        try {
          resolveResult(await work());
        } catch (error) {
          rejectResult(error);
        }
        const activeMs = Math.max(0, this.#now() - started);
        const pauseMs = Math.min(
          MAX_PAUSE_MS,
          Math.max(MIN_PAUSE_MS, activeMs * (1 / TARGET_BACKGROUND_DUTY - 1)),
        );
        await this.#interruptiblePause(pauseMs);
      });
    return result;
  }

  wakeInteractive(): void {
    this.#wakePause?.();
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

