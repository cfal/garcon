import crypto from 'node:crypto';
import type { AgentLogger } from '@garcon/server-agent-interface';

const WORKER_RESTART_DELAYS_MS = [1_000, 5_000, 30_000] as const;
const WORKER_HEALTHY_RESET_MS = 30_000;

export type SearchWorkerRole = 'indexer' | 'reader';

interface WorkerRequestEnvelope {
  readonly requestId: number;
  readonly lifecycleEpoch: string;
}

interface WorkerEventEnvelope {
  readonly lifecycleEpoch: string;
  readonly requestId?: number;
}

export type WorkerRequestInput<T extends WorkerRequestEnvelope> = T extends WorkerRequestEnvelope
  ? Omit<T, 'requestId' | 'lifecycleEpoch'>
  : never;

interface PendingRequest<Event> {
  resolve(value: Event): void;
  reject(error: Error): void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export interface SearchWorkerSupervisorOptions<
  Request extends WorkerRequestEnvelope,
  Event extends WorkerEventEnvelope,
> {
  readonly role: SearchWorkerRole;
  readonly moduleUrl: string;
  readonly logger: AgentLogger;
  readonly workerFactory?: (role: SearchWorkerRole, moduleUrl: string) => Worker;
  readonly createRequest: (
    input: WorkerRequestInput<Request>,
    envelope: WorkerRequestEnvelope,
  ) => Request;
  readonly isEvent: (value: unknown) => value is Event;
  readonly eventError: (event: Event) => Error | null;
  readonly shouldRestart: () => boolean;
  readonly admit: (signal: AbortSignal) => Promise<void>;
  readonly afterRestart?: () => Promise<void>;
  readonly onEvent: (event: Event) => void;
  readonly onCrash: () => void;
}

export class SearchWorkerSupervisor<
  Request extends WorkerRequestEnvelope,
  Event extends WorkerEventEnvelope,
> {
  readonly #options: SearchWorkerSupervisorOptions<Request, Event>;
  readonly #pending = new Map<number, PendingRequest<Event>>();
  #worker: Worker | null = null;
  #epoch = '';
  #requestId = 0;
  #restartAttempt = 0;
  #restarting = false;
  #stopping = false;
  #healthyTimer: ReturnType<typeof setTimeout> | null = null;
  #restartTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: SearchWorkerSupervisorOptions<Request, Event>) {
    this.#options = options;
  }

  get available(): boolean {
    return this.#worker !== null;
  }

  get epoch(): string {
    return this.#epoch;
  }

  async start(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.#worker) return;
    this.#stopping = false;
    this.#epoch = crypto.randomUUID();
    const worker = this.#options.workerFactory?.(this.#options.role, this.#options.moduleUrl)
      ?? new Worker(this.#options.moduleUrl, {
        name: `garcon-transcript-search-${this.#options.role}`,
        ref: true,
      });
    this.#worker = worker;
    worker.onmessage = (message: MessageEvent<unknown>) => {
      if (this.#worker !== worker) return;
      if (!this.#options.isEvent(message.data)) {
        this.#options.logger.warn(`Transcript ${this.#options.role} returned an invalid message.`, {
          code: this.#options.role === 'indexer'
            ? 'SEARCH_INDEXER_INVALID_MESSAGE'
            : 'SEARCH_READER_INVALID_MESSAGE',
        });
        this.crash();
        return;
      }
      const event = message.data;
      if (event.lifecycleEpoch !== this.#epoch) return;
      this.#settle(event);
      this.#options.onEvent(event);
    };
    worker.onerror = () => {
      if (this.#worker === worker) this.crash();
    };
    worker.onmessageerror = () => {
      if (this.#worker === worker) this.crash();
    };
    try {
      await this.#options.admit(signal);
    } catch (error) {
      this.#terminateCurrent(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  request(
    inputs: readonly WorkerRequestInput<Request>[],
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<Event> {
    signal?.throwIfAborted();
    const worker = this.#worker;
    if (!worker) {
      return Promise.reject(new Error(`Transcript search ${this.#options.role} is unavailable`));
    }
    const requestId = ++this.#requestId;
    const messages = inputs.map((input) => this.#options.createRequest(input, {
      requestId,
      lifecycleEpoch: this.#epoch,
    }));
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (work: () => void): void => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        work();
      };
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        finish(() => reject(new Error(
          this.#options.role === 'reader' ? 'SEARCH_TIMEOUT' : 'WORKER_TIMEOUT',
        )));
        this.crash();
      }, timeoutMs);
      timer.unref?.();
      const onAbort = (): void => {
        this.#pending.delete(requestId);
        clearTimeout(timer);
        finish(() => reject(new DOMException('Aborted', 'AbortError')));
        this.crash();
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#pending.set(requestId, {
        timer,
        resolve: (event) => finish(() => resolve(event)),
        reject: (error) => finish(() => reject(error)),
      });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      try {
        for (const message of messages) worker.postMessage(message);
      } catch (error) {
        this.#pending.delete(requestId);
        clearTimeout(timer);
        finish(() => reject(error instanceof Error ? error : new Error(String(error))));
      }
    });
  }

  post(message: Request): void {
    this.#worker?.postMessage(message);
  }

  crash(): void {
    if (!this.#worker) return;
    this.#terminateCurrent(new Error(`Transcript search ${this.#options.role} crashed`));
    this.#clearHealthyTimer();
    this.#options.onCrash();
    this.#scheduleRestart();
  }

  async stop(closeInput: WorkerRequestInput<Request>, timeoutMs: number): Promise<void> {
    this.#stopping = true;
    this.#restarting = false;
    this.#clearHealthyTimer();
    if (this.#restartTimer) clearTimeout(this.#restartTimer);
    this.#restartTimer = null;
    if (this.#worker) {
      await this.request([closeInput], undefined, timeoutMs).catch(() => undefined);
    }
    this.#terminateCurrent(new Error('Transcript search stopped'));
  }

  #settle(event: Event): void {
    if (event.requestId === undefined) return;
    const pending = this.#pending.get(event.requestId);
    if (!pending) return;
    this.#pending.delete(event.requestId);
    clearTimeout(pending.timer);
    const error = this.#options.eventError(event);
    if (error) pending.reject(error);
    else pending.resolve(event);
  }

  #terminateCurrent(error: Error): void {
    const worker = this.#worker;
    this.#worker = null;
    worker?.terminate();
    for (const [requestId, pending] of this.#pending) {
      this.#pending.delete(requestId);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  #scheduleRestart(): void {
    if (this.#stopping || this.#restarting || !this.#options.shouldRestart()) return;
    const delay = WORKER_RESTART_DELAYS_MS[Math.min(
      this.#restartAttempt,
      WORKER_RESTART_DELAYS_MS.length - 1,
    )];
    this.#restarting = true;
    this.#restartAttempt += 1;
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = null;
      void this.#restart();
    }, delay);
    this.#restartTimer.unref?.();
  }

  async #restart(): Promise<void> {
    if (this.#stopping || !this.#options.shouldRestart() || this.#worker) {
      this.#restarting = false;
      return;
    }
    try {
      await this.start(new AbortController().signal);
      await this.#options.afterRestart?.();
      this.#restarting = false;
      this.#clearHealthyTimer();
      this.#healthyTimer = setTimeout(() => {
        this.#restartAttempt = 0;
      }, WORKER_HEALTHY_RESET_MS);
      this.#healthyTimer.unref?.();
    } catch {
      this.#options.logger.warn(`Transcript ${this.#options.role} restart failed.`, {
        code: this.#options.role === 'indexer'
          ? 'SEARCH_INDEXER_RESTART_FAILED'
          : 'SEARCH_READER_RESTART_FAILED',
      });
      this.#terminateCurrent(new Error(`Transcript search ${this.#options.role} restart failed`));
      this.#restarting = false;
      this.#scheduleRestart();
    }
  }

  #clearHealthyTimer(): void {
    if (this.#healthyTimer) clearTimeout(this.#healthyTimer);
    this.#healthyTimer = null;
  }
}
