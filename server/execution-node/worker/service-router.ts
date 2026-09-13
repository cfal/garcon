import { nodeWorkerReplies } from './reply-port.js';
import { sameNodeSession } from '../../../common/node-operation.js';
import type { NodeConnectionLease } from '../supervisor.js';
import type { NodeWorkerAuthority } from './authority.js';
import { NodeWorkerTransportError } from './framing.js';
import { NodeWorkerServiceServer } from './service-channel.js';
import type { NodeWorkerServiceCommand, NodeWorkerServiceFrame, NodeWorkerServiceResult } from './service-protocol.js';
import type { NodeWorkerWriter } from './writer.js';
import type { NodeDeadline } from '../../execution-nodes/deadline.js';

export interface NodeWorkerServiceRouterOptions {
  readonly authority: NodeWorkerAuthority;
  readonly writer: Pick<NodeWorkerWriter, 'submit'>;
  execute(connectionId: number, connection: NodeConnectionLease, command: NodeWorkerServiceCommand, signal: AbortSignal, deadline: NodeDeadline): Promise<NodeWorkerServiceResult>;
}

export class NodeWorkerServiceRouter {
  readonly #closing = new AbortController();
  #connectionId: number;
  #channel: NodeWorkerServiceServer | null = null;

  constructor(connectionId: number, private readonly options: NodeWorkerServiceRouterOptions) {
    options.authority.connection(connectionId);
    this.#connectionId = connectionId;
  }

  receive(frame: NodeWorkerServiceFrame): void {
    this.#closing.signal.throwIfAborted();
    const { authority } = this.options;
    if (!sameNodeSession(frame.session, authority.session) || frame.connectionId > this.#connectionId) throw protocol();
    if (frame.connectionId < this.#connectionId) return;
    const connection = authority.connection(frame.connectionId);
    if (!this.#channel) {
      const signal = AbortSignal.any([connection.signal, this.#closing.signal]);
      const connectionId = frame.connectionId;
      this.#channel = new NodeWorkerServiceServer(nodeWorkerReplies(this.options.writer),
        (command, caller, deadline) => this.options.execute(connectionId, connection, command, caller, deadline), {
          session: authority.session, connectionId, signal, validate: () => authority.assertConnection(connection),
          failed() { if (!signal.aborted) authority.retire(); },
        });
    }
    this.#channel.receive(frame);
  }

  attach(connectionId: number): void {
    this.#closing.signal.throwIfAborted();
    this.options.authority.connection(connectionId);
    if (connectionId <= this.#connectionId) throw protocol();
    this.#connectionId = connectionId; this.#channel?.close(); this.#channel = null;
  }

  close(): void { this.#closing.abort(); this.#channel?.close(); this.#channel = null; }
}

function protocol(): NodeWorkerTransportError { return new NodeWorkerTransportError('NODE_WORKER_PROTOCOL'); }
