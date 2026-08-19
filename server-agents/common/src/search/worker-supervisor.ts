import crypto from 'node:crypto';
import type { AgentLogger } from '@garcon/server-agent-interface';

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

export interface PhasedWorkerRequest<Event> {
  readonly startTimeoutMs: number;
  readonly physicalTimeoutMs: number;
  readonly isStarted: (event: Event) => boolean;
  readonly isComplete: (event: Event) => boolean;
  readonly matches?: (event: Event) => boolean;
}

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
  timer: ReturnType<typeof setTimeout> | null;
  phase: 'ordinary' | 'start' | 'physical' | 'close';
  readonly timing: PhasedWorkerRequest<Event> | null;
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
  readonly onEvent: (event: Event) => void;
  readonly onFault?: (error: Error) => void;
  readonly setTimeout?: typeof setTimeout;
  readonly clearTimeout?: typeof clearTimeout;
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
  #retiring = false;
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

  async start(
    signal: AbortSignal,
    admit: (signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    signal.throwIfAborted();
    if (this.#worker) throw new Error(`Transcript search ${this.#options.role} is already started`);
    this.#retiring = false;
    this.#epoch = crypto.randomUUID();
    const worker = this.#options.workerFactory?.(this.#options.role, this.#options.moduleUrl)
      ?? new Worker(this.#options.moduleUrl, {
        name: `garcon-transcript-search-${this.#options.role}`,
        ref: true,
      });
    this.#worker = worker;
    this.#closedPromise = new Promise<void>((resolve) => { this.#closedResolve = resolve; });
    worker.onmessage = (message: MessageEvent<unknown>) => this.#receive(worker, message.data);
    worker.onerror = () => this.#fault(worker, new Error(
      `Transcript search ${this.#options.role} worker error`,
    ));
    worker.onmessageerror = () => this.#fault(worker, new Error(
      `Transcript search ${this.#options.role} message error`,
    ));
    worker.addEventListener('close', () => this.#closed(worker), { once: true });
    try {
      await admit(signal);
    } catch (error) {
      this.#retiring = true;
      this.#rejectPending(asError(error));
      throw error;
    }
  }

  request(
    inputs: readonly WorkerRequestInput<Request>[],
    signal: AbortSignal | undefined,
    timeout: number | PhasedWorkerRequest<Event>,
  ): Promise<Event> {
    return this.#request(inputs, signal, timeout, false, null);
  }

  beginRequestSession(): SearchWorkerRequestSession<WorkerRequestInput<Request>, Event> {
    const requestId = ++this.#requestId;
    return {
      requestId,
      request: (inputs, signal, timeoutMs, response) => this.#request(
        inputs,
        signal,
        timeoutMs,
        false,
        requestId,
        response,
      ),
    };
  }

  async cooperativeClose(
    closeInputs: readonly WorkerRequestInput<Request>[] | WorkerRequestInput<Request>,
    timeoutMs: number,
  ): Promise<void> {
    const worker = this.#worker;
    if (!worker) return;
    this.#retiring = true;
    this.#rejectPending(new Error(`Transcript search ${this.#options.role} is retiring`));
    const acknowledgement = this.#request(
      asInputs(closeInputs),
      undefined,
      timeoutMs,
      true,
      null,
    );
    const actualClose = withTimeout(
      this.#closedPromise,
      timeoutMs,
      `Transcript search ${this.#options.role} did not close`,
    );
    const [acknowledged, closed] = await Promise.allSettled([acknowledgement, actualClose]);
    if (acknowledged.status === 'rejected') throw acknowledged.reason;
    if (closed.status === 'rejected') throw closed.reason;
  }

  async stop(
    closeInputs: readonly WorkerRequestInput<Request>[] | WorkerRequestInput<Request>,
    timeoutMs: number,
  ): Promise<void> {
    const worker = this.#worker;
    if (!worker) return;
    try {
      await this.cooperativeClose(closeInputs, timeoutMs);
    } catch {
      if (this.#worker === worker) {
        worker.terminate();
        this.#closed(worker);
      }
    }
  }

  #request(
    inputs: readonly WorkerRequestInput<Request>[],
    signal: AbortSignal | undefined,
    timeout: number | PhasedWorkerRequest<Event>,
    retiringRequest: boolean,
    fixedRequestId: number | null,
    response: WorkerResponseMatcher<Event> | null = null,
  ): Promise<Event> {
    signal?.throwIfAborted();
    const worker = this.#worker;
    if (!worker || (this.#retiring && !retiringRequest)) {
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
    const phased = typeof timeout === 'number' ? null : timeout;
    const timeoutMs = typeof timeout === 'number' ? timeout : timeout.startTimeoutMs;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (work: () => void): void => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        work();
      };
      let pending!: PendingRequest<Event>;
      const onTimeout = (): void => {
        if (this.#pending.delete(requestId)) {
          const error = new Error(timeoutCode(this.#options.role, pending.phase));
          pending.reject(error);
          if (!retiringRequest) this.#fault(worker, error);
        }
      };
      pending = {
        timer: null,
        phase: retiringRequest ? 'close' : phased ? 'start' : 'ordinary',
        timing: phased,
        response,
        resolve: (event) => finish(() => resolve(event)),
        reject: (error) => finish(() => reject(error)),
      };
      const onAbort = (): void => {
        if (!this.#pending.delete(requestId)) return;
        this.#cancelTimeout(pending.timer);
        const error = new DOMException('Aborted', 'AbortError');
        pending.reject(error);
        if (!retiringRequest) this.#fault(worker, error);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#pending.set(requestId, pending);
      if (signal?.aborted) {
        onAbort();
        return;
      }
      try {
        for (const message of messages) worker.postMessage(message);
        if (this.#pending.has(requestId) && pending.timer === null) {
          pending.timer = this.#scheduleTimeout(onTimeout, timeoutMs);
          pending.timer.unref?.();
        }
      } catch (error) {
        this.#pending.delete(requestId);
        this.#cancelTimeout(pending.timer);
        const failure = asError(error);
        pending.reject(failure);
        if (!retiringRequest) this.#fault(worker, failure);
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
      this.#fault(worker, new Error(`Transcript search ${this.#options.role} invalid message`));
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
    const matches = pending.timing?.matches ?? pending.response?.matches;
    if (matches && !matches(event)) {
      this.#fault(this.#worker, new Error('Transcript search physical grant identity mismatch'));
      return;
    }
    const error = this.#options.eventError(event);
    if (error) {
      this.#pending.delete(event.requestId);
      this.#cancelTimeout(pending.timer);
      pending.reject(error);
      return;
    }
    if (pending.timing?.isStarted(event)) {
      if (pending.phase !== 'start') {
        this.#fault(this.#worker, new Error('Transcript search duplicate step-started event'));
        return;
      }
      this.#cancelTimeout(pending.timer);
      pending.phase = 'physical';
      pending.timer = this.#scheduleTimeout(() => {
        if (!this.#pending.delete(event.requestId!)) return;
        const timeout = new Error(timeoutCode(this.#options.role, pending.phase));
        pending.reject(timeout);
        this.#fault(this.#worker, timeout);
      }, pending.timing.physicalTimeoutMs);
      pending.timer.unref?.();
      return;
    }
    if (pending.timing && !pending.timing.isComplete(event)) return;
    if (pending.response && !pending.response.isComplete(event)) return;
    this.#pending.delete(event.requestId);
    this.#cancelTimeout(pending.timer);
    pending.resolve(event);
  }

  #fault(worker: Worker | null, error: Error): void {
    if (!worker || this.#worker !== worker || this.#retiring) return;
    this.#retiring = true;
    this.#rejectPending(error);
    this.#options.onFault?.(error);
  }

  #closed(worker: Worker): void {
    if (this.#worker !== worker) return;
    const unexpected = !this.#retiring;
    this.#worker = null;
    this.#retiring = false;
    this.#rejectPending(new Error(`Transcript search ${this.#options.role} closed`));
    this.#closedResolve?.();
    this.#closedResolve = null;
    if (unexpected) {
      this.#options.onFault?.(new Error(
        `Transcript search ${this.#options.role} closed unexpectedly`,
      ));
    }
  }

  #rejectPending(error: Error): void {
    for (const [requestId, pending] of this.#pending) {
      this.#pending.delete(requestId);
      this.#cancelTimeout(pending.timer);
      pending.reject(error);
    }
  }

  #scheduleTimeout(callback: () => void, timeoutMs: number): ReturnType<typeof setTimeout> {
    return (this.#options.setTimeout ?? setTimeout)(callback, timeoutMs);
  }

  #cancelTimeout(timer: ReturnType<typeof setTimeout> | null): void {
    if (timer !== null) (this.#options.clearTimeout ?? clearTimeout)(timer);
  }
}

function timeoutCode(role: SearchWorkerRole, phase: PendingRequest<unknown>['phase']): string {
  if (phase === 'start') return 'WORKER_STEP_START_TIMEOUT';
  if (phase === 'physical') return 'WORKER_PHYSICAL_STEP_TIMEOUT';
  if (phase === 'close') return 'WORKER_CLOSE_TIMEOUT';
  return role === 'reader' ? 'SEARCH_TIMEOUT' : 'WORKER_TIMEOUT';
}

function asInputs<T>(inputs: readonly T[] | T): readonly T[] {
  return Array.isArray(inputs) ? inputs as readonly T[] : [inputs as T];
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
