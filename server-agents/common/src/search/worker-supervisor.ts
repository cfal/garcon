import crypto from 'node:crypto';
import type { AgentLogger } from '@garcon/server-agent-interface';

const WORKER_RESTART_DELAYS_MS = [1_000, 5_000, 30_000] as const;
const WORKER_HEALTHY_RESET_MS = 30_000;
const RETIREMENT_WATCHDOG_MS = 30_000;

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

export interface WorkerResponseMatcher<Event> {
  readonly isComplete: (event: Event) => boolean;
  readonly matches?: (event: Event) => boolean;
}

export interface SearchWorkerRequestSession<Request, Event> {
  readonly requestId: number;
  request(
    inputs: readonly Request[],
    signal: AbortSignal | undefined,
    timeoutMs: number,
    response: WorkerResponseMatcher<Event>,
  ): Promise<Event>;
}

interface PendingRequest<Event> {
  resolve(value: Event): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  readonly timeoutMs: number;
  readonly onDeadline: () => void;
  readonly response: WorkerResponseMatcher<Event> | null;
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
  readonly isProgress?: (event: Event) => boolean;
  readonly shouldRestart: () => boolean;
  readonly admit: (signal: AbortSignal) => Promise<void>;
  readonly afterRestart?: () => Promise<void>;
  readonly onAdmitted?: () => void;
  readonly onEvent: (event: Event) => void;
  readonly onCrash?: () => void;
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
  #retiring = false;
  #stopping = false;
  #healthyTimer: ReturnType<typeof setTimeout> | null = null;
  #restartTimer: ReturnType<typeof setTimeout> | null = null;
  #closeWatchdog: ReturnType<typeof setTimeout> | null = null;
  #closedResolve: (() => void) | null = null;
  #closedPromise: Promise<void> = Promise.resolve();

  constructor(options: SearchWorkerSupervisorOptions<Request, Event>) {
    this.#options = options;
  }

  get available(): boolean {
    return this.#worker !== null && !this.#retiring;
  }

  get epoch(): string {
    return this.#epoch;
  }

  async start(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.#worker) {
      throw new Error(`Transcript search ${this.#options.role} is already started`);
    }
    this.#stopping = false;
    this.#retiring = false;
    this.#epoch = crypto.randomUUID();
    this.#spawn();
    try {
      await this.#options.admit(signal);
      this.#options.onAdmitted?.();
    } catch (error) {
      this.#retire(asError(error));
      throw error;
    }
  }

  request(
    inputs: readonly WorkerRequestInput<Request>[],
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<Event> {
    return this.#request(inputs, signal, timeoutMs, null, null, false);
  }

  beginRequestSession(): SearchWorkerRequestSession<WorkerRequestInput<Request>, Event> {
    const requestId = ++this.#requestId;
    return {
      requestId,
      request: (inputs, signal, timeoutMs, response) => this.#request(
        inputs,
        signal,
        timeoutMs,
        requestId,
        response,
        false,
      ),
    };
  }

  crash(): void {
    this.#retire(new Error(`Transcript search ${this.#options.role} crashed`));
  }

  async stop(closeInput: WorkerRequestInput<Request>, timeoutMs: number): Promise<void> {
    this.#stopping = true;
    this.#restarting = false;
    this.#clearHealthyTimer();
    if (this.#restartTimer) clearTimeout(this.#restartTimer);
    this.#restartTimer = null;
    const worker = this.#worker;
    if (!worker) return;

    if (!this.#retiring) {
      const acknowledgement = this.#request(
        [closeInput],
        undefined,
        timeoutMs,
        null,
        null,
        true,
      );
      const closed = withTimeout(
        this.#closedPromise,
        timeoutMs,
        `Transcript search ${this.#options.role} did not close`,
      );
      const outcomes = await Promise.allSettled([acknowledgement, closed]);
      if (outcomes.every((outcome) => outcome.status === 'fulfilled')) return;
    }

    if (this.#worker === worker) this.#retire(new Error('Transcript search stopped'));
    await withTimeout(
      this.#closedPromise,
      timeoutMs,
      `Transcript search ${this.#options.role} did not retire`,
    ).catch(() => undefined);
  }

  #spawn(): Worker {
    const worker = this.#options.workerFactory?.(this.#options.role, this.#options.moduleUrl)
      ?? new Worker(this.#options.moduleUrl, {
        name: `garcon-transcript-search-${this.#options.role}`,
        ref: true,
      });
    this.#worker = worker;
    this.#closedPromise = new Promise<void>((resolve) => {
      this.#closedResolve = resolve;
    });
    worker.onmessage = (message: MessageEvent<unknown>) => this.#receive(worker, message.data);
    worker.onerror = () => this.#retire(new Error(
      `Transcript search ${this.#options.role} worker error`,
    ));
    worker.onmessageerror = () => this.#retire(new Error(
      `Transcript search ${this.#options.role} message error`,
    ));
    worker.addEventListener('close', () => this.#onWorkerClose(worker), { once: true });
    return worker;
  }

  #request(
    inputs: readonly WorkerRequestInput<Request>[],
    signal: AbortSignal | undefined,
    timeoutMs: number,
    fixedRequestId: number | null,
    response: WorkerResponseMatcher<Event> | null,
    stoppingRequest: boolean,
  ): Promise<Event> {
    signal?.throwIfAborted();
    const worker = this.#worker;
    if (!worker || (this.#retiring && !stoppingRequest)) {
      return Promise.reject(new Error(`Transcript search ${this.#options.role} is unavailable`));
    }
    const requestId = fixedRequestId ?? ++this.#requestId;
    if (this.#pending.has(requestId)) {
      return Promise.reject(new Error(`Transcript search ${this.#options.role} request is active`));
    }
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
      const onDeadline = (): void => {
        if (!this.#pending.delete(requestId)) return;
        this.#retire(new Error(`Transcript search ${this.#options.role} grace exhausted`));
        finish(() => reject(new Error(
          this.#options.role === 'reader' ? 'SEARCH_TIMEOUT' : 'WORKER_TIMEOUT',
        )));
      };
      const timer = setTimeout(onDeadline, timeoutMs);
      timer.unref?.();
      const onAbort = (): void => {
        if (!this.#pending.delete(requestId)) return;
        clearTimeout(timer);
        finish(() => reject(new DOMException('Aborted', 'AbortError')));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#pending.set(requestId, {
        timer,
        timeoutMs,
        onDeadline,
        response,
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
        finish(() => reject(asError(error)));
        if (!stoppingRequest) this.#retire(asError(error));
      }
    });
  }

  #receive(worker: Worker, value: unknown): void {
    if (this.#worker !== worker) return;
    if (!this.#options.isEvent(value)) {
      this.#options.logger.warn(`Transcript ${this.#options.role} returned an invalid message.`, {
        code: this.#options.role === 'indexer'
          ? 'SEARCH_INDEXER_INVALID_MESSAGE'
          : 'SEARCH_READER_INVALID_MESSAGE',
      });
      this.#retire(new Error(`Transcript search ${this.#options.role} invalid message`));
      return;
    }
    if (value.lifecycleEpoch !== this.#epoch) return;
    this.#settle(value);
    this.#options.onEvent(value);
  }

  #settle(event: Event): void {
    if (event.requestId === undefined) return;
    const pending = this.#pending.get(event.requestId);
    if (!pending) return;
    if (pending.response?.matches && !pending.response.matches(event)) {
      this.#retire(new Error('Transcript search response identity mismatch'));
      return;
    }
    const error = this.#options.eventError(event);
    if (error) {
      this.#pending.delete(event.requestId);
      clearTimeout(pending.timer);
      pending.reject(error);
      return;
    }
    if (pending.response && !pending.response.isComplete(event)) return;
    if (pending.response === null && this.#options.isProgress?.(event)) {
      clearTimeout(pending.timer);
      pending.timer = setTimeout(pending.onDeadline, pending.timeoutMs);
      pending.timer.unref?.();
      return;
    }
    this.#pending.delete(event.requestId);
    clearTimeout(pending.timer);
    pending.resolve(event);
  }

  #retire(error: Error): void {
    const worker = this.#worker;
    if (!worker || this.#retiring) return;
    this.#retiring = true;
    this.#rejectPending(error);
    if (!this.#stopping) this.#options.onCrash?.();
    this.#clearHealthyTimer();
    this.#closeWatchdog = setTimeout(() => {
      this.#closeWatchdog = null;
      this.#options.logger.warn('Transcript search worker did not close after terminate.', {
        code: this.#options.role === 'reader'
          ? 'SEARCH_READER_CLOSE_MISSING'
          : 'SEARCH_INDEXER_CLOSE_MISSING',
      });
    }, RETIREMENT_WATCHDOG_MS);
    this.#closeWatchdog.unref?.();
    worker.terminate();
  }

  #onWorkerClose(worker: Worker): void {
    if (worker !== this.#worker) return;
    const expected = this.#retiring || this.#stopping;
    if (this.#closeWatchdog) {
      clearTimeout(this.#closeWatchdog);
      this.#closeWatchdog = null;
    }
    this.#worker = null;
    this.#retiring = false;
    this.#restarting = false;
    if (!expected) {
      this.#rejectPending(new Error(`Transcript search ${this.#options.role} closed`));
      this.#options.onCrash?.();
    }
    this.#closedResolve?.();
    this.#closedResolve = null;
    if (!this.#stopping && this.#options.shouldRestart()) this.#scheduleRestart();
  }

  #rejectPending(error: Error): void {
    for (const [requestId, pending] of this.#pending) {
      this.#pending.delete(requestId);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  #scheduleRestart(): void {
    if (
      this.#stopping
      || this.#restarting
      || this.#worker
      || !this.#options.shouldRestart()
    ) return;
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
      this.#restarting = false;
      await this.start(new AbortController().signal);
      await this.#options.afterRestart?.();
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
      if (!this.#worker) this.#scheduleRestart();
    }
  }

  #clearHealthyTimer(): void {
    if (this.#healthyTimer) clearTimeout(this.#healthyTimer);
    this.#healthyTimer = null;
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref?.();
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
