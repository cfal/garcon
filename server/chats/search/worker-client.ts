import { withPromiseTimeout } from '../../lib/promise-timeout.js';
import type {
  TranscriptSearchProgressEvent,
  TranscriptSearchWorkerMessage,
  TranscriptSearchWorkerRequest,
  TranscriptSearchWorkerResponse,
  TranscriptSearchWorkerRole,
} from './worker-protocol.js';
import { isTranscriptSearchWorkerMessage } from './worker-protocol.js';
import { resolveTranscriptSearchWorkerPath } from './worker-runtime.js';

type RequestInput = TranscriptSearchWorkerRequest extends infer Request
  ? Request extends TranscriptSearchWorkerRequest
    ? Omit<Request, 'requestId' | 'lifecycleEpoch'>
    : never
  : never;

export class TranscriptSearchWorkerError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'TranscriptSearchWorkerError';
  }
}

export interface TranscriptSearchWorkerClientOptions {
  workerFactory?: (role: TranscriptSearchWorkerRole) => Worker;
  onProgress?: (progress: TranscriptSearchProgressEvent) => void;
  onCrash?: (error: Error) => void;
  searchTimeoutMs?: number;
}

export class TranscriptSearchWorkerClient {
  readonly #workers: Record<TranscriptSearchWorkerRole, Worker>;
  readonly #lifecycleEpoch: number;
  readonly #pending = new Map<number, {
    resolve: (response: TranscriptSearchWorkerResponse) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout> | null;
  }>();
  readonly #onProgress?: (progress: TranscriptSearchProgressEvent) => void;
  readonly #onCrash?: (error: Error) => void;
  readonly #searchTimeoutMs: number;
  readonly #workerClosed: Record<TranscriptSearchWorkerRole, Promise<void>>;
  readonly #resolveWorkerClosed: Record<TranscriptSearchWorkerRole, () => void>;
  #requestId = 0;
  #closed = false;
  #closing = false;
  #crashed = false;

  constructor(lifecycleEpoch: number, options: TranscriptSearchWorkerClientOptions = {}) {
    this.#lifecycleEpoch = lifecycleEpoch;
    this.#onProgress = options.onProgress;
    this.#onCrash = options.onCrash;
    this.#searchTimeoutMs = options.searchTimeoutMs ?? 2_000;
    this.#resolveWorkerClosed = {} as Record<TranscriptSearchWorkerRole, () => void>;
    this.#workerClosed = {} as Record<TranscriptSearchWorkerRole, Promise<void>>;
    this.#workers = {} as Record<TranscriptSearchWorkerRole, Worker>;
    try {
      for (const role of ['writer', 'reader'] as const) {
        this.#workerClosed[role] = new Promise((resolve) => {
          this.#resolveWorkerClosed[role] = resolve;
        });
        const worker = options.workerFactory?.(role) ?? new Worker(
          resolveTranscriptSearchWorkerPath(),
          { name: `garcon-transcript-search-${role}`, ref: true },
        );
        this.#workers[role] = worker;
        worker.onmessage = (event: MessageEvent<unknown>) => this.#handleMessage(event.data);
        worker.onerror = (event: ErrorEvent) => {
          this.#failAll(new Error(event.message || `Transcript search ${role} worker crashed`));
        };
        worker.addEventListener('close', () => {
          this.#resolveWorkerClosed[role]();
          if (!this.#closing && !this.#closed && !this.#crashed) {
            this.#failAll(new Error(`Transcript search ${role} worker closed unexpectedly`));
          }
        });
      }
    } catch (error) {
      this.#closing = true;
      for (const worker of Object.values(this.#workers)) worker.terminate();
      throw error;
    }
  }

  async open(dbPath: string): Promise<number> {
    try {
      const writer = await this.#request({ type: 'open', dbPath, role: 'writer' }, 'writer');
      if (writer.type !== 'opened') throw new Error('Unexpected transcript search writer open response');
      const reader = await this.#request({ type: 'open', dbPath, role: 'reader' }, 'reader');
      if (reader.type !== 'opened') throw new Error('Unexpected transcript search reader open response');
      return writer.generationFloor;
    } catch (error) {
      await this.terminate();
      throw error;
    }
  }

  async request(input: RequestInput): Promise<TranscriptSearchWorkerResponse> {
    return this.#request(input);
  }

  async close(timeoutMs = 5_000): Promise<void> {
    if (this.#closed) return;
    this.#closing = true;
    try {
      await this.#closeEndpoint('reader', timeoutMs);
      await this.#closeEndpoint('writer', timeoutMs);
    } catch {
      for (const role of ['reader', 'writer'] as const) {
        this.#workers[role].terminate();
        this.#resolveWorkerClosed[role]();
      }
      await Promise.all(Object.values(this.#workerClosed).map((closed) => withPromiseTimeout(
        closed,
        timeoutMs,
        'Transcript search forced termination',
      ).catch(() => undefined)));
    } finally {
      this.#closed = true;
      this.#failAll(new Error('Transcript search worker closed'));
    }
  }

  async terminate(timeoutMs = 5_000): Promise<void> {
    if (this.#closed) return;
    this.#closing = true;
    this.#closed = true;
    for (const role of ['reader', 'writer'] as const) {
      this.#workers[role].terminate();
      this.#resolveWorkerClosed[role]();
    }
    await Promise.all(Object.values(this.#workerClosed).map((closed) => withPromiseTimeout(
      closed,
      timeoutMs,
      'Transcript search worker termination',
    ).catch(() => undefined)));
    this.#failAll(new Error('Transcript search worker terminated'));
  }

  async #closeEndpoint(role: TranscriptSearchWorkerRole, timeoutMs: number): Promise<void> {
    const response = await withPromiseTimeout(
      this.#request({ type: 'close' }, role),
      timeoutMs,
      `Transcript search ${role} worker close`,
    );
    if (response.type !== 'closed') throw new Error(`Unexpected transcript search ${role} close response`);
    this.#workers[role].terminate();
    this.#resolveWorkerClosed[role]();
  }

  #request(
    input: RequestInput,
    role: TranscriptSearchWorkerRole = input.type === 'search' ? 'reader' : 'writer',
  ): Promise<TranscriptSearchWorkerResponse> {
    if (this.#closed) return Promise.reject(new Error('Transcript search worker is closed'));
    const requestId = ++this.#requestId;
    const request = {
      ...input,
      requestId,
      lifecycleEpoch: this.#lifecycleEpoch,
    } as TranscriptSearchWorkerRequest;
    return new Promise((resolve, reject) => {
      const timeoutMs = input.type === 'search'
        ? this.#searchTimeoutMs
        : input.type === 'close'
          ? null
        : input.type === 'rebuild-chat'
          ? 30 * 60_000
          : 30_000;
      const timer = timeoutMs === null ? null : setTimeout(() => {
        if (!this.#pending.has(requestId)) return;
        if (input.type === 'search') {
          this.#failAll(new TranscriptSearchWorkerError(
            'SEARCH_TIMEOUT',
            `Transcript search request timed out after ${timeoutMs}ms`,
            true,
          ));
          return;
        }
        this.#pending.delete(requestId);
        reject(new Error(`Transcript search worker ${input.type} request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer?.unref?.();
      this.#pending.set(requestId, { resolve, reject, timer });
      try {
        this.#workers[role].postMessage(request);
      } catch (error) {
        this.#pending.delete(requestId);
        if (timer) clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  #handleMessage(value: unknown): void {
    if (!isTranscriptSearchWorkerMessage(value)) {
      this.#failAll(new Error('Transcript search worker sent an invalid protocol message'));
      return;
    }
    const message = value as TranscriptSearchWorkerMessage;
    if (message.lifecycleEpoch !== this.#lifecycleEpoch) return;
    if (message.type === 'progress') {
      this.#onProgress?.(message);
      return;
    }
    if (message.type === 'fatal') {
      this.#failAll(new TranscriptSearchWorkerError(message.code, message.message, true));
      return;
    }
    const pending = this.#pending.get(message.requestId);
    if (!pending) return;
    this.#pending.delete(message.requestId);
    if (pending.timer) clearTimeout(pending.timer);
    if (message.type === 'error') {
      pending.reject(new TranscriptSearchWorkerError(message.code, message.message, message.retryable));
    } else {
      pending.resolve(message);
    }
  }

  #failAll(error: Error): void {
    if (!this.#closed && !this.#closing && !this.#crashed) {
      this.#crashed = true;
      for (const role of ['reader', 'writer'] as const) {
        this.#workers[role].terminate();
        this.#resolveWorkerClosed[role]();
      }
      this.#onCrash?.(error);
    }
    for (const pending of this.#pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}
