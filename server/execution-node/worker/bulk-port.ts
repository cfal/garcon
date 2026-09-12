import { NODE_WIRE_VERSION } from '@garcon/server-agent-interface';
import { isExecutionIdentity } from '../../../common/execution-location.js';
import { parseNodeSessionIdentity, type NodeSessionIdentity } from '../../../common/node-operation.js';
import { NodeBulkError } from '../../execution-nodes/transport/bulk-transfers.js';
import { NodeWorkerTransportError } from './framing.js';
import { serializeNodeWorkerBulk } from './bulk-protocol.js';
import type { NodeWorkerFramePriority, NodeWorkerSubmission, NodeWorkerWriter } from './writer.js';

export interface NodeWorkerBulkPortOptions {
  readonly session: NodeSessionIdentity;
  readonly connectionId: number;
  readonly instanceId: string;
  readonly signal: AbortSignal;
  validate(): void;
  closed(): void;
}

/** Keeps each bulk chunk charged to the shared pipe until native drain, leaving lifecycle slots reserved. */
export class NodeWorkerBulkPort {
  readonly #session: NodeSessionIdentity;
  readonly #closing = new AbortController();
  readonly #detach: () => void;

  constructor(private readonly writer: Pick<NodeWorkerWriter, 'submit'>, private readonly options: NodeWorkerBulkPortOptions) {
    const session = parseNodeSessionIdentity(options.session);
    if (!session || !isExecutionIdentity(options.instanceId) || !Number.isSafeInteger(options.connectionId)
      || options.connectionId < 1) throw new TypeError('Invalid worker bulk connection');
    this.#session = Object.freeze(session);
    const close = () => this.close();
    options.signal.addEventListener('abort', close, { once: true });
    this.#detach = () => options.signal.removeEventListener('abort', close);
    if (options.signal.aborted) this.close();
  }

  send(payload: string): boolean {
    try { this.#submit(payload, 'urgent', this.#closing.signal); return true; }
    catch (error) {
      if (error instanceof NodeWorkerTransportError && error.code === 'NODE_WORKER_CAPACITY') return false;
      throw error;
    }
  }

  async sendWhenWritable(payload: string, caller: AbortSignal, validate: () => void = () => {}): Promise<void> {
    const signal = AbortSignal.any([caller, this.#closing.signal]);
    try { await this.#submit(payload, 'data', signal, validate).drained; }
    catch (error) {
      if (error instanceof NodeWorkerTransportError && error.code === 'NODE_WORKER_CAPACITY') {
        throw new NodeBulkError('NODE_CAPACITY', 'Worker bulk writes are at capacity');
      }
      throw error;
    }
  }

  async writable(signal: AbortSignal): Promise<void> { this.#validate(); signal.throwIfAborted(); }

  close(): void {
    if (this.#closing.signal.aborted) return;
    this.#detach();
    this.#closing.abort(new NodeWorkerTransportError('NODE_WORKER_CLOSED'));
    try { this.options.closed(); } catch { /* Closing a channel cannot restore its queued authority. */ }
  }

  #submit(payload: string, priority: NodeWorkerFramePriority, signal: AbortSignal, validate: () => void = () => {}): NodeWorkerSubmission {
    this.#validate(); signal.throwIfAborted(); validate();
    const text = serializeNodeWorkerBulk({ type: 'node-worker-bulk', version: NODE_WIRE_VERSION, session: this.#session,
      connectionId: this.options.connectionId, instanceId: this.options.instanceId, payload });
    const submission = this.writer.submit(text, priority, { signal, validate: () => { this.#validate(); validate(); } });
    void submission.drained.catch((error) => { if (!signal.aborted && !(error instanceof NodeBulkError)) this.close(); });
    return submission;
  }

  #validate(): void {
    this.#closing.signal.throwIfAborted();
    try { this.options.signal.throwIfAborted(); this.options.validate(); }
    catch (error) { this.close(); throw error; }
    this.#closing.signal.throwIfAborted();
  }
}
