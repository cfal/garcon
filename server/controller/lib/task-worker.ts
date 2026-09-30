import {
  resolveWorkerEntrypoint,
  type GarconWorkerName,
} from '@garcon/server-agent-common/build/standalone-entrypoint';
import { yieldToEventLoop } from '@garcon/server-agent-common/shared/event-loop';
import { isTaskWorkerEvent, type TaskWorkerRequest } from './task-worker-protocol.js';

// Bounds each structured clone by item count and by the text it carries, so a transcript
// with very large messages still crosses to the Worker in short main-thread slices.
const BATCH_ITEMS = 256;
const BATCH_BYTES = 4 * 1024 * 1024;

export interface TaskWorkerOptions {
  readonly worker: GarconWorkerName;
  readonly sourceUrl: URL;
  // Prefixes this worker's errors, e.g. "Token fitting".
  readonly label: string;
}

interface QueuedTask<Task> {
  readonly task: Task;
  readonly items: readonly unknown[];
  readonly signal: AbortSignal | undefined;
  resolve(result: unknown): void;
  reject(error: unknown): void;
}

interface ActiveTask<Task> {
  readonly taskId: number;
  readonly worker: Worker;
  readonly queued: QueuedTask<Task>;
}

// Runs whole-transcript computations on one lazily started Worker so long transcripts
// never stall the controller's event loop. Tasks run one at a time. The Worker is
// stateless between tasks, so aborting the running task simply terminates it and the
// next task starts a fresh one.
export class TaskWorker<
  Task extends { readonly kind: string },
  Results extends { readonly [K in Task['kind']]: unknown },
> {
  readonly #options: TaskWorkerOptions;
  readonly #queue: QueuedTask<Task>[] = [];
  #active: ActiveTask<Task> | null = null;
  #worker: Worker | null = null;
  #taskId = 0;
  #closed = false;

  constructor(options: TaskWorkerOptions) {
    this.#options = options;
  }

  run<K extends Task['kind']>(
    task: Extract<Task, { readonly kind: K }>,
    items: readonly unknown[],
    signal: AbortSignal | undefined,
  ): Promise<Results[K]> {
    if (this.#closed) return Promise.reject(this.#closedError());
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const onAbort = () => this.#abort(queued);
      const queued: QueuedTask<Task> = {
        task,
        items,
        signal,
        resolve: (result) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(result as Results[K]);
        },
        reject: (error) => {
          signal?.removeEventListener('abort', onAbort);
          reject(error);
        },
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#queue.push(queued);
      this.#pump();
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const error = this.#closedError();
    const active = this.#active;
    this.#active = null;
    if (this.#worker) this.#retire(this.#worker);
    active?.queued.reject(error);
    for (const queued of this.#queue.splice(0)) queued.reject(error);
  }

  #closedError(): Error {
    return new Error(`${this.#options.label} is closed`);
  }

  #pump(): void {
    if (this.#active || this.#closed) return;
    const queued = this.#queue.shift();
    if (!queued) return;
    this.#worker ??= this.#spawn();
    const active: ActiveTask<Task> = { taskId: ++this.#taskId, worker: this.#worker, queued };
    this.#active = active;
    void this.#send(active);
  }

  async #send(active: ActiveTask<Task>): Promise<void> {
    const { taskId, worker, queued } = active;
    const post = (request: TaskWorkerRequest<Task>) => worker.postMessage(request);
    try {
      post({ type: 'begin', taskId, task: queued.task });
      let offset = 0;
      while (offset < queued.items.length) {
        await yieldToEventLoop();
        if (this.#active !== active) return;
        const end = batchEnd(queued.items, offset);
        post({ type: 'items', taskId, items: queued.items.slice(offset, end) });
        offset = end;
      }
      post({ type: 'run', taskId });
    } catch (error) {
      if (this.#active === active) this.#lose(worker, error);
    }
  }

  #abort(queued: QueuedTask<Task>): void {
    const index = this.#queue.indexOf(queued);
    if (index >= 0) {
      this.#queue.splice(index, 1);
    } else if (this.#active?.queued === queued) {
      this.#retire(this.#active.worker);
      this.#active = null;
    } else {
      return;
    }
    queued.reject(queued.signal?.reason);
    this.#pump();
  }

  #spawn(): Worker {
    const { label } = this.#options;
    // The Worker never keeps the process alive on its own.
    const worker = new Worker(
      resolveWorkerEntrypoint(this.#options.worker, this.#options.sourceUrl),
      { name: `garcon-${this.#options.worker}`, ref: false },
    );
    worker.onmessage = (message: MessageEvent<unknown>) => this.#receive(worker, message.data);
    worker.onerror = (event) => this.#lose(worker, new Error(`${label} worker failed: ${event.message}`));
    worker.onmessageerror = () => this.#lose(worker, new Error(`${label} worker message failed`));
    worker.addEventListener(
      'close',
      () => this.#lose(worker, new Error(`${label} worker exited`)),
      { once: true },
    );
    return worker;
  }

  #receive(worker: Worker, data: unknown): void {
    const active = this.#active;
    if (active?.worker !== worker) return;
    if (!isTaskWorkerEvent(data) || data.taskId !== active.taskId) {
      this.#lose(worker, new Error(`${this.#options.label} worker sent an invalid event`));
      return;
    }
    this.#active = null;
    if (data.type === 'result') active.queued.resolve(data.result);
    else active.queued.reject(Object.assign(new Error(data.message), data.code === undefined ? {} : { code: data.code }));
    this.#pump();
  }

  #lose(worker: Worker, error: unknown): void {
    if (this.#worker !== worker) return;
    const active = this.#active;
    this.#retire(worker);
    if (active?.worker === worker) {
      this.#active = null;
      active.queued.reject(error);
    }
    this.#pump();
  }

  #retire(worker: Worker): void {
    worker.onmessage = null;
    worker.onerror = null;
    worker.onmessageerror = null;
    worker.terminate();
    if (this.#worker === worker) this.#worker = null;
  }
}

// Ends a batch at the item limit, or before the item that would exceed the byte budget;
// an item larger than the budget travels alone.
function batchEnd(items: readonly unknown[], start: number): number {
  let end = start;
  let bytes = 0;
  while (end < items.length && end - start < BATCH_ITEMS) {
    bytes += cloneBytes(items[end]);
    if (end > start && bytes > BATCH_BYTES) break;
    end += 1;
  }
  return end;
}

// Estimates the cost of cloning a transcript item, which its text dominates.
function cloneBytes(value: unknown): number {
  let bytes = 0;
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const next = pending.pop();
    if (typeof next === 'string') bytes += next.length;
    else if (next !== null && typeof next === 'object') {
      if (seen.has(next)) continue;
      seen.add(next);
      for (const child of Array.isArray(next) ? next : Object.values(next)) pending.push(child);
    } else bytes += 8;
  }
  return bytes;
}
