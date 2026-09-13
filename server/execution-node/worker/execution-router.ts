import { immediateNodeReplies } from '../../execution-nodes/transport/reply-port.js';
import { sameNodeSession } from '../../../common/node-operation.js';
import { NodeExecutionRequestBudget, NodeExecutionServer } from '../../execution-nodes/transport/execution-channel.js';
import type { NodeExecutionCommand } from '../../execution-nodes/transport/execution-wire.js';
import type { NodeExecutionResult } from '../../execution-nodes/transport/execution-receipt-wire.js';
import type { NodeConnectionLease } from '../supervisor.js';
import type { NodeWorkerAuthority } from './authority.js';
import { NodeWorkerExecutionPort } from './execution-port.js';
import type { NodeWorkerExecutionFrame } from './execution-protocol.js';
import { NodeWorkerTransportError } from './framing.js';
import type { NodeWorkerWriter } from './writer.js';
import { NODE_WORKER_EXECUTION_LIMITS } from './limits.js';
import type { NodeDeadline } from '../../execution-nodes/deadline.js';

export interface NodeWorkerExecutionRouterOptions {
  readonly authority: NodeWorkerAuthority;
  readonly instanceIds: ReadonlySet<string>;
  readonly writer: Pick<NodeWorkerWriter, 'submit'>;
  execute(instanceId: string, connectionId: number, connection: NodeConnectionLease,
    command: NodeExecutionCommand, signal: AbortSignal, deadline: NodeDeadline): Promise<NodeExecutionResult>;
}

/** Keeps request ordering, cancellation and replies inside their configured instance and physical connection. */
export class NodeWorkerExecutionRouter {
  readonly #channels = new Map<string, NodeExecutionServer>();
  readonly #budget = new NodeExecutionRequestBudget(NODE_WORKER_EXECUTION_LIMITS);
  readonly #closing = new AbortController();
  #connectionId: number;

  constructor(connectionId: number, private readonly options: NodeWorkerExecutionRouterOptions) {
    if (!Number.isSafeInteger(connectionId) || connectionId < 1) throw new NodeWorkerTransportError('NODE_WORKER_PROTOCOL');
    this.#connectionId = connectionId;
  }

  receive(frame: NodeWorkerExecutionFrame): void {
    this.#closing.signal.throwIfAborted();
    const { authority } = this.options;
    if (!sameNodeSession(frame.session, authority.session) || !this.options.instanceIds.has(frame.instanceId)
      || frame.connectionId > this.#connectionId) throw new NodeWorkerTransportError('NODE_WORKER_PROTOCOL');
    if (frame.connectionId < this.#connectionId) return;
    const connection = authority.connection(frame.connectionId);
    let channel = this.#channels.get(frame.instanceId);
    if (!channel) {
      const signal = AbortSignal.any([connection.signal, this.#closing.signal]);
      const validate = () => authority.assertConnection(connection);
      const port = new NodeWorkerExecutionPort(this.options.writer, { session: authority.session, connectionId: frame.connectionId,
        instanceId: frame.instanceId, signal, validate,
        closed() { if (!signal.aborted) authority.retire(); } });
      const { instanceId, connectionId } = frame;
      channel = new NodeExecutionServer(immediateNodeReplies(port), {
        execute: (command, signal, deadline) => this.options.execute(instanceId, connectionId, connection, command, signal, deadline),
      }, { ...NODE_WORKER_EXECUTION_LIMITS, session: authority.session, signal, budget: this.#budget, validate });
      this.#channels.set(instanceId, channel);
    }
    channel.receive(frame.payload);
  }

  attach(connectionId: number): void {
    this.#closing.signal.throwIfAborted();
    this.options.authority.connection(connectionId);
    if (connectionId <= this.#connectionId) throw new NodeWorkerTransportError('NODE_WORKER_PROTOCOL');
    this.#connectionId = connectionId;
    this.#channels.clear();
  }

  close(): void {
    this.#closing.abort();
    this.#channels.clear();
  }
}
