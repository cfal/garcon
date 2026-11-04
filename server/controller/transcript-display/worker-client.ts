import { resolveWorkerEntrypoint } from '@garcon/server-agent-common/build/standalone-entrypoint';
import { DomainError } from '../../common/domain-error.js';
import type { DisplayWorkerReply, DisplayWorkerRequest, DisplayWorkerResults, DisplayWorkerTask } from './worker-protocol.js';

interface Pending {
  id: number; task: DisplayWorkerTask; timeout: number; signal?: AbortSignal;
  resolve(value: unknown): void; reject(error: unknown): void;
}

export interface DisplayWorkerHandle {
  onmessage: ((event: MessageEvent<DisplayWorkerReply>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage(value: DisplayWorkerRequest): void;
  terminate(): void;
  addEventListener(type: 'close', listener: () => void, options?: { once: boolean }): void;
}

interface WorkerOptions {
  readonly createWorker?: () => DisplayWorkerHandle;
  readonly retirementTimeoutMs?: number;
}

export class DisplayWorkerClient {
  #worker: DisplayWorkerHandle | null = null;
  #retiring: DisplayWorkerHandle | null = null;
  #retired: Promise<void> = Promise.resolve();
  #active: Pending | null = null;
  #queue: Pending[] = [];
  #nextId = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #closed = false;
  #unavailable = false;

  constructor(readonly role: 'builder' | 'reader', readonly options: WorkerOptions = {}) {}

  request<K extends DisplayWorkerTask['kind']>(task: Extract<DisplayWorkerTask, { kind: K }>, signal?: AbortSignal, timeout = 10000): Promise<DisplayWorkerResults[K]> {
    if (this.#closed) return Promise.reject(new Error('Display worker closed'));
    if (this.#unavailable) return Promise.reject(new DomainError('DISPLAY_UNAVAILABLE', 'Transcript display worker is unavailable.', 503, true));
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.#queue.length >= 32) return Promise.reject(new DomainError('DISPLAY_BUSY', 'Transcript display is busy.', 503, true));
    return new Promise((resolve, reject) => {
      const abort = () => {
        const index = this.#queue.indexOf(pending);
        if (index >= 0) { this.#queue.splice(index, 1); pending.reject(signal?.reason); }
        else if (this.#active === pending) {
          // A cancelled caller cannot release a writer before its transaction has settled.
          // Its reply still retires the active slot; publication is fenced by the service.
          pending.reject(signal?.reason);
        }
      };
      const pending: Pending = { id: ++this.#nextId, task, timeout, signal,
        resolve: value => { signal?.removeEventListener('abort', abort); resolve(value as DisplayWorkerResults[K]); },
        reject: error => { signal?.removeEventListener('abort', abort); reject(error); } };
      signal?.addEventListener('abort', abort, { once: true });
      this.#queue.push(pending); this.#pump();
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const pending of this.#queue.splice(0)) pending.reject(new Error('Display worker closed'));
    if (this.#worker) this.#retire(this.#worker, new Error('Display worker closed'));
    await this.#retired;
  }

  #pump(): void {
    if (this.#closed || this.#unavailable || this.#active || this.#retiring) return;
    const pending = this.#queue.shift();
    if (!pending) return;
    let worker: DisplayWorkerHandle;
    try { worker = this.#worker ??= this.#spawn(); }
    catch {
      const failure = new DomainError('DISPLAY_UNAVAILABLE', 'Transcript display worker could not start.', 503, true);
      pending.reject(failure);
      for (const waiting of this.#queue.splice(0)) waiting.reject(failure);
      return;
    }
    this.#active = pending;
    this.#timer = setTimeout(() => this.#retire(worker, Object.assign(new Error('Display work timed out'),
      { code: pending.task.kind === 'bash' ? 'DISPLAY_FILTER_TIMEOUT' : 'DISPLAY_TIMEOUT' })), pending.timeout);
    try { worker.postMessage({ id: pending.id, task: pending.task }); }
    catch { this.#retire(worker, new DomainError('DISPLAY_UNAVAILABLE', 'Transcript display request could not start.', 503, true)); }
  }

  #spawn(): DisplayWorkerHandle {
    const worker = this.options.createWorker?.() ?? new Worker(resolveWorkerEntrypoint(`transcript-display-${this.role}`, new URL(`./${this.role}-main.ts`, import.meta.url)),
      { name: `garcon-transcript-display-${this.role}`, ref: false });
    worker.onmessage = (event: MessageEvent<DisplayWorkerReply>) => {
      const pending = this.#active;
      if (this.#worker !== worker || !pending) return;
      const reply = event.data;
      if (!reply || reply.id !== pending.id || typeof reply.ok !== 'boolean') {
        this.#retire(worker, new Error('Invalid display worker reply')); return;
      }
      clearTimeout(this.#timer); this.#active = null;
      if (reply.ok) pending.resolve(reply.result);
      else pending.reject(Object.assign(new Error(reply.code), { code: reply.code }));
      this.#pump();
    };
    worker.onerror = () => this.#retire(worker, new DomainError('DISPLAY_UNAVAILABLE', 'Display worker failed', 503, true));
    worker.onmessageerror = () => this.#retire(worker, new DomainError('DISPLAY_UNAVAILABLE', 'Display worker reply failed', 503, true));
    worker.addEventListener('close', () => {
      if (this.#worker === worker) { this.#worker = null; this.#active?.reject(new DomainError('DISPLAY_UNAVAILABLE', 'Display worker exited', 503, true)); this.#active = null; clearTimeout(this.#timer); this.#pump(); }
    });
    return worker;
  }

  #retire(worker: DisplayWorkerHandle, error: unknown): void {
    if (this.#worker !== worker) return;
    this.#worker = null; this.#retiring = worker;
    clearTimeout(this.#timer);
    const pending = this.#active; this.#active = null;
    this.#retired = new Promise(resolve => {
      const watchdog = setTimeout(() => {
        this.#unavailable = true;
        const failure = new DomainError('DISPLAY_UNAVAILABLE', 'Transcript display worker has not retired.', 503, true);
        pending?.reject(failure);
        for (const waiting of this.#queue.splice(0)) waiting.reject(failure);
        resolve();
      }, this.options.retirementTimeoutMs ?? 30000);
      worker.addEventListener('close', () => {
        clearTimeout(watchdog);
        this.#retiring = null; this.#unavailable = false;
        resolve(); pending?.reject(error); this.#pump();
      }, { once: true });
    });
    worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null;
    try { worker.terminate(); } catch { /* The retirement watchdog keeps the writer fenced. */ }
  }
}
