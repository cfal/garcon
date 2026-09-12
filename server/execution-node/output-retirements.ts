import { producerStreamKey } from '@garcon/server-agent-interface';
import { parseNodeSessionIdentity, sameNodeSession, type NodeSessionIdentity } from '../../common/node-operation.js';
import { MAX_NODE_STREAM_IDENTITIES, NodeStreamIdentityExhaustedError } from './replay-cache.js';
import { NodeWorkerTransportError } from './worker/framing.js';
import { parseNodeWorkerOutputRetirementText, type NodeWorkerOutputRetirement } from './worker/output-retirement.js';

export const MAX_NODE_RETIREMENT_BARRIERS = 16;

export interface NodeOutputRetirementsOptions {
  readonly session: NodeSessionIdentity;
  readonly instanceIds: ReadonlySet<string>;
  readonly signal: AbortSignal;
}

/** Retains body-free logical retirements because pipe drain is not controller receipt. */
export class NodeOutputRetirements {
  readonly #frames = new Map<string, NodeWorkerOutputRetirement>();
  readonly #closing = new AbortController();
  readonly #detach: () => void;
  #replaying = false;
  readonly #waiters = new Set<() => void>();

  constructor(private readonly options: NodeOutputRetirementsOptions) {
    const session = parseNodeSessionIdentity(options.session);
    if (!session) throw protocol();
    this.options = Object.freeze({ ...options, session: Object.freeze(session), instanceIds: new Set(options.instanceIds) });
    const close = () => this.close();
    this.#detach = () => options.signal.removeEventListener('abort', close);
    options.signal.addEventListener('abort', close, { once: true });
    if (options.signal.aborted) this.close();
  }

  record(value: NodeWorkerOutputRetirement): NodeWorkerOutputRetirement {
    this.#closing.signal.throwIfAborted();
    const frame = parseNodeWorkerOutputRetirementText(JSON.stringify(value));
    if (!frame || !sameNodeSession(frame.stream, this.options.session) || !this.options.instanceIds.has(frame.instanceId)) throw protocol();
    const key = producerStreamKey(frame.stream);
    const existing = this.#frames.get(key);
    if (existing) {
      if (existing.instanceId !== frame.instanceId) throw protocol();
      return existing;
    }
    if (this.#frames.size >= MAX_NODE_STREAM_IDENTITIES) throw new NodeStreamIdentityExhaustedError();
    const captured = Object.freeze({ ...frame, stream: Object.freeze(frame.stream) });
    this.#frames.set(key, captured);
    return captured;
  }

  async replay(send: (frame: NodeWorkerOutputRetirement, signal: AbortSignal) => Promise<void>, signal: AbortSignal): Promise<void> {
    this.#closing.signal.throwIfAborted(); signal.throwIfAborted();
    const lifetime = AbortSignal.any([signal, this.#closing.signal]);
    while (this.#replaying) { await this.#wait(lifetime); lifetime.throwIfAborted(); }
    this.#replaying = true;
    try {
      for (const frame of this.#frames.values()) {
        lifetime.throwIfAborted();
        await send(frame, lifetime);
        lifetime.throwIfAborted();
      }
    } finally {
      this.#replaying = false;
      for (const wake of this.#waiters) wake();
    }
  }

  close(): void {
    if (this.#closing.signal.aborted) return;
    this.#closing.abort(new NodeWorkerTransportError('NODE_WORKER_CLOSED'));
    this.#detach(); this.#frames.clear();
  }

  #wait(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.#waiters.size >= MAX_NODE_RETIREMENT_BARRIERS) throw new NodeWorkerTransportError('NODE_WORKER_CAPACITY');
    const result = Promise.withResolvers<void>();
    const detach = () => { this.#waiters.delete(wake); signal.removeEventListener('abort', cancel); };
    const wake = () => { detach(); result.resolve(); };
    const cancel = () => { detach(); result.reject(signal.reason); };
    this.#waiters.add(wake);
    signal.addEventListener('abort', cancel, { once: true });
    return result.promise;
  }
}

function protocol(): NodeWorkerTransportError { return new NodeWorkerTransportError('NODE_WORKER_PROTOCOL'); }
