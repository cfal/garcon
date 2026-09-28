import { resolveWorkerEntrypoint } from '@garcon/server-agent-common/build/standalone-entrypoint';
import { yieldToEventLoop } from '@garcon/server-agent-common/shared/event-loop';
import type { ChatMessage } from '../../../../common/chat-types.js';
import type { RenderedHandoffArtifact } from '../handoff-artifact/model.js';
import type {
  CarryoverAssessment,
  CompactionPromptFit,
  CompactionPromptInput,
} from './carryover.js';
import { isTokenFittingEvent, type TokenFittingRequest } from './protocol.js';
import type {
  HandoffArtifactRenderInput,
  TokenFittingResults,
  TokenFittingTask,
  TokenFittingTaskKind,
} from './tasks.js';

const WORKER_SOURCE_URL = new URL('./worker-main.ts', import.meta.url);
// Bounds each structured clone so a long transcript crosses to the Worker in
// short main-thread slices instead of one long copy.
const ITEMS_PER_MESSAGE = 256;

export interface TokenFitting {
  assessCarryover(
    messages: readonly ChatMessage[],
    signal?: AbortSignal,
  ): Promise<CarryoverAssessment>;
  fitCompactionPrompt(
    input: CompactionPromptInput,
    signal?: AbortSignal,
  ): Promise<CompactionPromptFit>;
  renderHandoffArtifact(
    input: HandoffArtifactRenderInput,
    signal?: AbortSignal,
  ): Promise<RenderedHandoffArtifact | null>;
}

interface QueuedTask {
  readonly task: TokenFittingTask;
  readonly items: readonly unknown[];
  readonly signal: AbortSignal | undefined;
  resolve(result: unknown): void;
  reject(error: unknown): void;
}

interface ActiveTask {
  readonly taskId: number;
  readonly worker: Worker;
  readonly queued: QueuedTask;
}

// Runs token estimation and fitting on one lazily started Worker so long
// transcripts never stall the controller's event loop. Tasks run one at a time.
// The Worker is stateless between tasks, so aborting the running task simply
// terminates it and the next task starts a fresh one.
export class TokenFittingWorker implements TokenFitting {
  readonly #queue: QueuedTask[] = [];
  #active: ActiveTask | null = null;
  #worker: Worker | null = null;
  #taskId = 0;
  #closed = false;

  assessCarryover(
    messages: readonly ChatMessage[],
    signal?: AbortSignal,
  ): Promise<CarryoverAssessment> {
    return this.#run({ kind: 'assess-carryover' }, messages, signal);
  }

  fitCompactionPrompt(
    { messages, ...parameters }: CompactionPromptInput,
    signal?: AbortSignal,
  ): Promise<CompactionPromptFit> {
    return this.#run({ kind: 'fit-compaction-prompt', ...parameters }, messages, signal);
  }

  renderHandoffArtifact(
    { entries, ...parameters }: HandoffArtifactRenderInput,
    signal?: AbortSignal,
  ): Promise<RenderedHandoffArtifact | null> {
    return this.#run({ kind: 'render-handoff-artifact', ...parameters }, entries, signal);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const error = new Error('Token fitting is closed');
    const active = this.#active;
    this.#active = null;
    if (this.#worker) this.#retire(this.#worker);
    active?.queued.reject(error);
    for (const queued of this.#queue.splice(0)) queued.reject(error);
  }

  #run<K extends TokenFittingTaskKind>(
    task: Extract<TokenFittingTask, { readonly kind: K }>,
    items: readonly unknown[],
    signal: AbortSignal | undefined,
  ): Promise<TokenFittingResults[K]> {
    if (this.#closed) return Promise.reject(new Error('Token fitting is closed'));
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const onAbort = () => this.#abort(queued);
      const queued: QueuedTask = {
        task,
        items,
        signal,
        resolve: (result) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(result as TokenFittingResults[K]);
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

  #pump(): void {
    if (this.#active || this.#closed) return;
    const queued = this.#queue.shift();
    if (!queued) return;
    this.#worker ??= this.#spawn();
    const active: ActiveTask = { taskId: ++this.#taskId, worker: this.#worker, queued };
    this.#active = active;
    void this.#send(active);
  }

  async #send(active: ActiveTask): Promise<void> {
    const { taskId, worker, queued } = active;
    const post = (request: TokenFittingRequest) => worker.postMessage(request);
    try {
      post({ type: 'begin', taskId, task: queued.task });
      for (let offset = 0; offset < queued.items.length; offset += ITEMS_PER_MESSAGE) {
        await yieldToEventLoop();
        if (this.#active !== active) return;
        post({ type: 'items', taskId, items: queued.items.slice(offset, offset + ITEMS_PER_MESSAGE) });
      }
      post({ type: 'run', taskId });
    } catch (error) {
      if (this.#active === active) this.#lose(worker, error);
    }
  }

  #abort(queued: QueuedTask): void {
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
    // The Worker never keeps the process alive on its own.
    const worker = new Worker(
      resolveWorkerEntrypoint('token-fitting', WORKER_SOURCE_URL),
      { name: 'garcon-token-fitting', ref: false },
    );
    worker.onmessage = (message: MessageEvent<unknown>) => this.#receive(worker, message.data);
    worker.onerror = (event) => this.#lose(
      worker,
      new Error(`Token fitting worker failed: ${event.message}`),
    );
    worker.onmessageerror = () => this.#lose(worker, new Error('Token fitting worker message failed'));
    worker.addEventListener(
      'close',
      () => this.#lose(worker, new Error('Token fitting worker exited')),
      { once: true },
    );
    return worker;
  }

  #receive(worker: Worker, data: unknown): void {
    const active = this.#active;
    if (active?.worker !== worker) return;
    if (!isTokenFittingEvent(data) || data.taskId !== active.taskId) {
      this.#lose(worker, new Error('Token fitting worker sent an invalid event'));
      return;
    }
    this.#active = null;
    if (data.type === 'result') active.queued.resolve(data.result);
    else active.queued.reject(new Error(data.message));
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
