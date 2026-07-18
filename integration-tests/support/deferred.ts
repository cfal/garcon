export class Deferred<T> {
  readonly promise: Promise<T>;
  #settled = false;
  #resolve!: (value: T | PromiseLike<T>) => void;
  #reject!: (reason?: unknown) => void;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
  }

  get settled(): boolean {
    return this.#settled;
  }

  resolve(value: T): boolean {
    if (this.#settled) return false;
    this.#settled = true;
    this.#resolve(value);
    return true;
  }

  reject(reason: unknown): boolean {
    if (this.#settled) return false;
    this.#settled = true;
    this.#reject(reason);
    return true;
  }
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  describe: () => string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(describe())), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

