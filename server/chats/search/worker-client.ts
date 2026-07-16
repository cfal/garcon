import { withPromiseTimeout } from '../../lib/promise-timeout.js';
import type {
  TranscriptSearchProgressEvent,
  TranscriptSearchWorkerMessage,
  TranscriptSearchWorkerRequest,
  TranscriptSearchWorkerResponse,
} from './worker-protocol.js';
import { isTranscriptSearchWorkerMessage } from './worker-protocol.js';

type RequestInput = TranscriptSearchWorkerRequest extends infer Request
  ? Request extends TranscriptSearchWorkerRequest
    ? Omit<Request, 'requestId' | 'lifecycleEpoch'>
    : never
  : never;

export class TranscriptSearchWorkerError extends Error {
  constructor(
    public readonly code: string,
    message: string,
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
  }>();
  readonly #onProgress?: (progress: TranscriptSearchProgressEvent) => void;
  readonly #onCrash?: (error: Error) => void;
  #requestId = 0;
  #closed = false;

  constructor(lifecycleEpoch: number, options: TranscriptSearchWorkerClientOptions = {}) {
    this.#lifecycleEpoch = lifecycleEpoch;
    this.#onProgress = options.onProgress;
    this.#onCrash = options.onCrash;
    this.#worker = options.workerFactory?.() ?? new Worker(
      new URL('./worker.ts', import.meta.url).href,
      { name: 'garcon-transcript-search', ref: true },
    );
    this.#worker.onmessage = (event: MessageEvent<unknown>) => this.#handleMessage(event.data);
    this.#worker.onerror = (event: ErrorEvent) => {
      this.#failAll(new Error(event.message || 'Transcript search worker crashed'));
    };
  }

  async open(dbPath: string): Promise<void> {
    const response = await this.#request({ type: 'open', dbPath });
    if (response.type !== 'opened') throw new Error('Unexpected transcript search open response');
  }

  async request(input: RequestInput): Promise<TranscriptSearchWorkerResponse> {
    return this.#request(input);
  }

  async close(timeoutMs = 5_000): Promise<void> {
    if (this.#closed) return;
    try {
      const response = await withPromiseTimeout(
        this.#request({ type: 'close' }),
        timeoutMs,
        'Transcript search worker close',
      );
      if (response.type !== 'closed') throw new Error('Unexpected transcript search close response');
    } catch {
      this.#worker.terminate();
    } finally {
      this.#closed = true;
      this.#failAll(new Error('Transcript search worker closed'));
    }
  }

  terminate(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#worker.terminate();
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
      this.#pending.set(requestId, { resolve, reject });
      try {
        this.#worker.postMessage(request);
      } catch (error) {
        this.#pending.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  #handleMessage(value: unknown): void {
    if (!isTranscriptSearchWorkerMessage(value)) return;
    const message = value as TranscriptSearchWorkerMessage;
    if (message.lifecycleEpoch !== this.#lifecycleEpoch) return;
    if (message.type === 'progress') {
      this.#onProgress?.(message);
      return;
    }
    const pending = this.#pending.get(message.requestId);
    if (!pending) return;
    this.#pending.delete(message.requestId);
    if (message.type === 'error') {
      pending.reject(new TranscriptSearchWorkerError(message.code, message.message));
    } else {
      pending.resolve(message);
    }
  }

  #failAll(error: Error): void {
    if (!this.#closed) this.#onCrash?.(error);
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

