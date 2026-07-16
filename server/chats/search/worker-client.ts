import { withPromiseTimeout } from '../../lib/promise-timeout.js';
import type {
  TranscriptSearchProgressEvent,
  TranscriptSearchWorkerMessage,
  TranscriptSearchWorkerRequest,
  TranscriptSearchWorkerResponse,
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
  workerFactory?: () => Worker;
  onProgress?: (progress: TranscriptSearchProgressEvent) => void;
  onCrash?: (error: Error) => void;
}

export class TranscriptSearchWorkerClient {
  readonly #worker: Worker;
  readonly #lifecycleEpoch: number;
  readonly #pending = new Map<number, {
    resolve: (response: TranscriptSearchWorkerResponse) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout> | null;
  }>();
  readonly #onProgress?: (progress: TranscriptSearchProgressEvent) => void;
  readonly #onCrash?: (error: Error) => void;
  readonly #workerClosed: Promise<void>;
  #resolveWorkerClosed!: () => void;
  #requestId = 0;
  #closed = false;
  #closing = false;
  #crashed = false;

  constructor(lifecycleEpoch: number, options: TranscriptSearchWorkerClientOptions = {}) {
    this.#lifecycleEpoch = lifecycleEpoch;
    this.#onProgress = options.onProgress;
    this.#onCrash = options.onCrash;
    this.#workerClosed = new Promise((resolve) => {
      this.#resolveWorkerClosed = resolve;
    });
    this.#worker = options.workerFactory?.() ?? new Worker(
      resolveTranscriptSearchWorkerPath(),
      { name: 'garcon-transcript-search', ref: true },
    );
    this.#worker.onmessage = (event: MessageEvent<unknown>) => this.#handleMessage(event.data);
    this.#worker.onerror = (event: ErrorEvent) => {
      this.#failAll(new Error(event.message || 'Transcript search worker crashed'));
    };
    this.#worker.addEventListener('close', () => {
      this.#resolveWorkerClosed();
      if (!this.#closing && !this.#closed) {
        this.#failAll(new Error('Transcript search worker closed unexpectedly'));
      }
    });
  }

  async open(dbPath: string): Promise<number> {
    const response = await this.#request({ type: 'open', dbPath });
    if (response.type !== 'opened') throw new Error('Unexpected transcript search open response');
    return response.generationFloor;
  }

  async request(input: RequestInput): Promise<TranscriptSearchWorkerResponse> {
    return this.#request(input);
  }

  async close(timeoutMs = 5_000): Promise<void> {
    if (this.#closed) return;
    this.#closing = true;
    try {
      const response = await withPromiseTimeout(
        this.#request({ type: 'close' }),
        timeoutMs,
        'Transcript search worker close',
      );
      if (response.type !== 'closed') throw new Error('Unexpected transcript search close response');
      await withPromiseTimeout(this.#workerClosed, timeoutMs, 'Transcript search worker exit');
    } catch {
      this.#worker.terminate();
      await withPromiseTimeout(this.#workerClosed, timeoutMs, 'Transcript search forced termination')
        .catch(() => undefined);
    } finally {
      this.#closed = true;
      this.#failAll(new Error('Transcript search worker closed'));
    }
  }

  async terminate(timeoutMs = 5_000): Promise<void> {
    if (this.#closed) return;
    this.#closing = true;
    this.#closed = true;
    this.#worker.terminate();
    await withPromiseTimeout(this.#workerClosed, timeoutMs, 'Transcript search worker termination')
      .catch(() => undefined);
    this.#failAll(new Error('Transcript search worker terminated'));
  }

  #request(input: RequestInput): Promise<TranscriptSearchWorkerResponse> {
    if (this.#closed) return Promise.reject(new Error('Transcript search worker is closed'));
    const requestId = ++this.#requestId;
    const request = {
      ...input,
      requestId,
      lifecycleEpoch: this.#lifecycleEpoch,
    } as TranscriptSearchWorkerRequest;
    return new Promise((resolve, reject) => {
      const timeoutMs = input.type === 'search' || input.type === 'close'
        ? null
        : input.type === 'rebuild-chat'
          ? 30 * 60_000
          : 30_000;
      const timer = timeoutMs === null ? null : setTimeout(() => {
        if (!this.#pending.delete(requestId)) return;
        reject(new Error(`Transcript search worker ${input.type} request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer?.unref?.();
      this.#pending.set(requestId, { resolve, reject, timer });
      try {
        this.#worker.postMessage(request);
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
      this.#onCrash?.(error);
    }
    for (const pending of this.#pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}
