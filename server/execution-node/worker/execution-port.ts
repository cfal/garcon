import { NODE_WIRE_VERSION } from '@garcon/server-agent-interface';
import { isExecutionIdentity } from '../../../common/execution-location.js';
import { parseNodeSessionIdentity, type NodeSessionIdentity } from '../../../common/node-operation.js';
import {
  isNodeExecutionReconciliation, parseNodeExecutionCallText, parseNodeExecutionCancellationText,
} from '../../execution-nodes/transport/execution-wire.js';
import type { NodeSocketWriter } from '../../execution-nodes/transport/socket-writer.js';
import { NodeWorkerTransportError } from './framing.js';
import { serializeNodeWorkerExecution } from './execution-protocol.js';
import type { NodeFrameAdmission, NodeFrameSubmission, NodeFrameWriter, NodeWorkerFramePriority } from './writer.js';

export interface NodeWorkerExecutionPortOptions {
  readonly session: NodeSessionIdentity;
  readonly connectionId: number;
  readonly instanceId: string;
  readonly signal: AbortSignal;
  validate(): void;
  closed(): void;
}

interface PendingWrite {
  readonly cancellation: AbortController;
  submission: NodeFrameSubmission | null;
  cancelled: string | null;
}

/** Adapts channel admission to frame submission, retaining cancellation while native writes remain queued. */
export class NodeWorkerExecutionPort implements Pick<NodeSocketWriter, 'send' | 'close'> {
  readonly #session: NodeSessionIdentity;
  readonly #closing = new AbortController();
  readonly #requests = new Map<number, PendingWrite>();
  readonly #detach: () => void;

  constructor(private readonly writer: NodeFrameWriter, private readonly options: NodeWorkerExecutionPortOptions) {
    const session = parseNodeSessionIdentity(options.session);
    if (!session || !Number.isSafeInteger(options.connectionId) || options.connectionId < 1
      || !isExecutionIdentity(options.instanceId)) throw new TypeError('Invalid worker execution connection');
    this.#session = Object.freeze(session);
    const close = () => this.close();
    options.signal.addEventListener('abort', close, { once: true });
    this.#detach = () => options.signal.removeEventListener('abort', close);
    if (options.signal.aborted) this.close();
  }

  send(payload: string): boolean {
    this.#validate();
    const cancel = parseNodeExecutionCancellationText(payload);
    if (cancel) {
      const pending = this.#requests.get(cancel.requestId);
      if (pending) {
        pending.cancelled = payload;
        pending.cancellation.abort(new DOMException('Worker request cancelled', 'AbortError'));
        if (!pending.submission || !pending.submission.submitted) return true;
      }
      return this.#send(payload, null, 'application', 'urgent');
    }
    const request = parseNodeExecutionCallText(payload);
    if (!request) return this.#send(payload, null, 'application');
    if (this.#requests.has(request.requestId)) throw new NodeWorkerTransportError('NODE_WORKER_PROTOCOL');
    const pending: PendingWrite = { cancellation: new AbortController(), submission: null, cancelled: null };
    this.#requests.set(request.requestId, pending);
    try { return this.#send(payload, { requestId: request.requestId, pending }, isNodeExecutionReconciliation(request.command) ? 'application' : 'data'); }
    catch (error) { this.#requests.delete(request.requestId); throw error; }
  }

  close(): void {
    if (this.#closing.signal.aborted) return;
    this.#detach();
    this.#closing.abort(new NodeWorkerTransportError('NODE_WORKER_CLOSED'));
    this.#requests.clear();
    try { this.options.closed(); } catch { /* A connection observer cannot restore its queued authority. */ }
  }

  #send(payload: string, request: { requestId: number; pending: PendingWrite } | null,
    admission: NodeFrameAdmission, priority: NodeWorkerFramePriority = 'data'): boolean {
    const pending = request?.pending;
    const signal = pending ? AbortSignal.any([this.#closing.signal, pending.cancellation.signal]) : this.#closing.signal;
    const text = serializeNodeWorkerExecution({ type: 'node-worker-execution', version: NODE_WIRE_VERSION,
      session: this.#session, connectionId: this.options.connectionId, instanceId: this.options.instanceId, payload });
    let submission: NodeFrameSubmission;
    try { submission = this.writer.submit(text, priority, { signal, validate: () => this.#validate() }, admission); }
    catch (error) {
      if (request) this.#requests.delete(request.requestId);
      if (error instanceof NodeWorkerTransportError && error.code === 'NODE_WORKER_CAPACITY') return false;
      throw error;
    }
    const release = () => {
      if (request && this.#requests.get(request.requestId) === pending) this.#requests.delete(request.requestId);
    };
    if (submission.drained) void submission.drained.catch(() => { if (!signal.aborted) this.close(); }).finally(release);
    if (pending) {
      pending.submission = submission;
      if (pending.cancelled && submission.submitted) this.#send(pending.cancelled, null, 'application', 'urgent');
    }
    if (!submission.drained) release();
    return true;
  }

  #validate(): void {
    this.#closing.signal.throwIfAborted();
    try { this.options.signal.throwIfAborted(); this.options.validate(); }
    catch (error) { this.close(); throw error; }
    this.#closing.signal.throwIfAborted();
  }
}
