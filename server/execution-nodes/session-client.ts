import { sameNodeSession, type NodeSessionIdentity } from '../../common/node-operation.js';
import { nodeWorkerApplicationSession, parseNodeWorkerApplicationText, type NodeWorkerApplicationFrame } from '../execution-node/worker/application-protocol.js';
import { NodeWorkerExecutionPort } from '../execution-node/worker/execution-port.js';
import { NodeWorkerTransportError } from '../execution-node/worker/framing.js';
import type { NodeWorkerOutputRetirement } from '../execution-node/worker/output-retirement.js';
import { confirmNodeOutputRetirement } from '../execution-node/worker/output-retirement-client.js';
import { NodeWorkerServiceClient } from '../execution-node/worker/service-channel.js';
import type { NodeWorkerOutputAcknowledgement } from '../execution-node/worker/service-protocol.js';
import { NodeExecutionClient, NodeExecutionRequestBudget } from './transport/execution-channel.js';
import { NodeSessionSocketWriter } from './transport/session-socket-writer.js';
import type { NodeSocketWriter } from './transport/socket-writer.js';

export interface NodeSessionClientOptions {
  readonly session: NodeSessionIdentity;
  readonly connectionId: number;
  readonly instanceIds: ReadonlySet<string>;
  readonly signal: AbortSignal;
  validate(): void;
  received(frame: NodeWorkerApplicationFrame, text: string): void;
  disconnected(error: unknown): void;
}

/** Keeps controller RPC requests on one authenticated physical hop without replaying mutations. */
export class NodeSessionClient {
  readonly service: NodeWorkerServiceClient;
  readonly #closing = new AbortController();
  readonly #detach: () => void;
  readonly #submissions: NodeSessionSocketWriter;
  readonly #execution = new Map<string, NodeExecutionClient>();
  readonly #executionBudget = new NodeExecutionRequestBudget();

  constructor(private readonly writer: NodeSocketWriter, private readonly options: NodeSessionClientOptions) {
    this.options = Object.freeze({ ...options, session: Object.freeze({ ...options.session }), instanceIds: new Set(options.instanceIds) });
    this.#submissions = new NodeSessionSocketWriter(writer, this.#closing.signal);
    const close = () => this.close();
    this.#detach = () => options.signal.removeEventListener('abort', close);
    options.signal.addEventListener('abort', close, { once: true });
    this.service = new NodeWorkerServiceClient(this.#submissions, { session: this.options.session, connectionId: options.connectionId,
      signal: this.#closing.signal, validate: () => this.#validate(), failed: (error) => this.#close(error) });
    if (options.signal.aborted) this.close();
  }

  execution(instanceId: string): NodeExecutionClient {
    this.#validate();
    if (!this.options.instanceIds.has(instanceId)) throw protocol();
    const existing = this.#execution.get(instanceId);
    if (existing) return existing;
    const validate = () => this.#validate();
    const port = new NodeWorkerExecutionPort(this.#submissions, { session: this.options.session,
      connectionId: this.options.connectionId, instanceId, signal: this.#closing.signal, validate, closed: () => this.close() });
    const client = new NodeExecutionClient(port, { session: this.options.session, signal: this.#closing.signal, budget: this.#executionBudget, validate });
    this.#execution.set(instanceId, client);
    return client;
  }

  admitOutputAck(frame: NodeWorkerOutputAcknowledgement, signal: AbortSignal): boolean {
    this.#validate(); signal.throwIfAborted();
    const text = JSON.stringify(frame);
    if (!parseNodeWorkerApplicationText(text) || !sameNodeSession(nodeWorkerApplicationSession(frame), this.options.session)
      || frame.connectionId !== this.options.connectionId) throw protocol();
    this.#validate(); signal.throwIfAborted();
    return this.writer.sendApplication(text);
  }

  /** Confirms the exact instance output fence without claiming native settlement. */
  async retireOutput(target: Pick<NodeWorkerOutputRetirement, 'instanceId' | 'stream'>, signal: AbortSignal): Promise<void> {
    this.#validate(); signal.throwIfAborted();
    if (!this.options.instanceIds.has(target.instanceId)) throw protocol();
    await confirmNodeOutputRetirement(this.service, target, signal);
    this.#validate(); signal.throwIfAborted();
  }

  receive(text: string): void {
    if (this.#closing.signal.aborted) return;
    try {
      this.#validate();
      const frame = parseNodeWorkerApplicationText(text);
      if (!frame || !sameNodeSession(nodeWorkerApplicationSession(frame), this.options.session)
        || 'instanceId' in frame && !this.options.instanceIds.has(frame.instanceId)) throw protocol();
      if ('connectionId' in frame) {
        if (frame.connectionId < this.options.connectionId) return;
        if (frame.connectionId !== this.options.connectionId) throw protocol();
      }
      if (frame.type === 'node-worker-service-result') { this.service.receive(frame); return; }
      if (frame.type === 'node-worker-execution') {
        const client = this.#execution.get(frame.instanceId);
        if (!client) throw protocol();
        client.receive(frame.payload); return;
      }
      if (frame.type !== 'node-worker-output-retired' && frame.type !== 'node-worker-output-delivery'
        && frame.type !== 'node-worker-output-suspended') throw protocol();
      this.options.received(frame, text);
    } catch (error) { this.#close(error); }
  }

  close(): void { this.#close(new NodeWorkerTransportError('NODE_WORKER_CLOSED')); }

  #validate(): void {
    this.#closing.signal.throwIfAborted(); this.options.signal.throwIfAborted(); this.options.validate();
    this.#closing.signal.throwIfAborted();
  }

  #close(error: unknown): void {
    if (this.#closing.signal.aborted) return;
    this.#closing.abort(error); this.#detach(); this.service.close(); this.#execution.clear(); this.writer.close();
    try { this.options.disconnected(error); } catch { /* A physical close cannot grant replacement authority. */ }
  }
}

function protocol(): NodeWorkerTransportError { return new NodeWorkerTransportError('NODE_WORKER_PROTOCOL'); }
