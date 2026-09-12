import { producerStreamKey } from '@garcon/server-agent-interface';
import { MAX_NODE_STREAM_IDENTITIES } from '../replay-cache.js';
import { NodeWorkerTransportError } from './framing.js';
import type { NodeWorkerOutputRetirement } from './output-retirement.js';
import { NODE_WORKER_WRITER_LIMITS } from './limits.js';

export interface NodeWorkerRetirementRelayOptions {
  send(frame: NodeWorkerOutputRetirement, signal: AbortSignal): Promise<void>;
  waitForRelease(signal: AbortSignal): Promise<void>;
  failed(error: unknown): void;
  readonly scheduleTimeout?: (callback: () => void, delayMs: number) => { cancel(): void };
}

/** Paces logical retirement controls and provides a barrier before the next sibling output record. */
export class NodeWorkerRetirementRelay {
  readonly #pending = new Map<string, NodeWorkerOutputRetirement>();
  #running: Promise<void> | null = null;
  readonly #closing = new AbortController();

  constructor(private readonly options: NodeWorkerRetirementRelayOptions) {}

  enqueue(frame: NodeWorkerOutputRetirement): void {
    if (this.#closing.signal.aborted) return;
    const key = producerStreamKey(frame.stream);
    if (!this.#pending.has(key) && this.#pending.size >= MAX_NODE_STREAM_IDENTITIES) {
      this.#fail(new NodeWorkerTransportError('NODE_WORKER_CAPACITY')); return;
    }
    this.#pending.set(key, frame);
    if (this.#running) return;
    const completion = Promise.withResolvers<void>();
    this.#running = completion.promise;
    queueMicrotask(() => { void this.#pump().finally(completion.resolve); });
  }

  async flush(): Promise<void> {
    while (this.#running) await this.#running;
    this.#closing.signal.throwIfAborted();
  }

  close(): void { this.#closing.abort(new NodeWorkerTransportError('NODE_WORKER_CLOSED')); this.#pending.clear(); }

  async #pump(): Promise<void> {
    try {
      while (!this.#closing.signal.aborted && this.#pending.size) {
        const [key, frame] = this.#pending.entries().next().value!;
        await this.#deliver(frame);
        if (this.#pending.get(key) === frame) this.#pending.delete(key);
      }
    } catch (error) { this.#fail(error); }
    finally { this.#running = null; }
  }

  async #deliver(frame: NodeWorkerOutputRetirement): Promise<void> {
    const signal = this.#closing.signal;
    const timer = (this.options.scheduleTimeout ?? scheduleTimeout)(() => {
      this.#fail(new NodeWorkerTransportError('NODE_WORKER_TIMEOUT'));
    }, NODE_WORKER_WRITER_LIMITS.writeTimeoutMs);
    try {
      while (!signal.aborted) {
        let drained: Promise<void>;
        try { drained = this.options.send(frame, signal); }
        catch (error) {
          if (!(error instanceof NodeWorkerTransportError) || error.code !== 'NODE_WORKER_CAPACITY') throw error;
          await this.options.waitForRelease(signal);
          continue;
        }
        await drained;
        return;
      }
      signal.throwIfAborted();
    } finally { timer.cancel(); }
  }

  #fail(error: unknown): void {
    if (this.#closing.signal.aborted) return;
    this.close();
    try { this.options.failed(error); } catch { /* A failed relay cannot admit later sibling output. */ }
  }
}

function scheduleTimeout(callback: () => void, delayMs: number): { cancel(): void } {
  const timer = setTimeout(callback, delayMs); timer.unref();
  return { cancel: () => clearTimeout(timer) };
}
