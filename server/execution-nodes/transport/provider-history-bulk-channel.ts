import { NODE_WIRE_VERSION } from '@garcon/server-agent-interface';
import { isNodeBulkReply, parseNodeBulkFrameText } from './bulk-channel-wire.js';
import { NodeBulkChannel, type NodeBulkChannelOptions, type NodeBulkReceivePort } from './bulk-channel.js';
import { NodeBulkError } from './bulk-transfers.js';
import { parseNodeBulkIdentity, type NodeBulkIdentity } from './bulk-wire.js';
import { parseNodeHistoryBulkText, sameNodeHistoryBulkTarget, serializeNodeHistoryBulk, type NodeHistoryBulkFrame,
  type NodeHistoryBulkTarget } from './provider-history-bulk-wire.js';

export interface NodeHistoryBulkPort {
  send(frame: NodeHistoryBulkFrame): boolean;
  /** Resolves only after the bounded local writer releases the submitted frame. */
  sendWhenWritable(frame: NodeHistoryBulkFrame, signal: AbortSignal, validate: () => void): Promise<void>;
}

export interface NodeHistoryBulkChannelOptions extends NodeHistoryBulkTarget {
  readonly side: 'sender' | 'receiver';
  readonly signal: AbortSignal;
  readonly scheduleTimeout?: NodeBulkChannelOptions['scheduleTimeout'];
  validate(): void;
  closed(): void;
}

/** Owns one reverse transfer; protocol failure cancels its row without closing the shared transport. */
export class NodeHistoryBulkChannel {
  readonly #target: NodeHistoryBulkTarget;
  readonly #closing = new AbortController();
  readonly #channel: NodeBulkChannel;

  constructor(port: NodeHistoryBulkPort, receiver: NodeBulkReceivePort, private readonly options: NodeHistoryBulkChannelOptions) {
    const probe = parseNodeHistoryBulkText(JSON.stringify({ ...targetFields(options), type: 'node-history-bulk', version: NODE_WIRE_VERSION,
      payload: JSON.stringify({ type: 'node-bulk-cancel', version: NODE_WIRE_VERSION, transfer: options.grant, requestId: 1 }) }));
    if (!probe) throw new TypeError('Invalid history bulk target');
    this.#target = Object.freeze({ ...targetFields(probe), identity: Object.freeze(probe.identity), grant: Object.freeze(probe.grant) });
    const validate = () => { this.#closing.signal.throwIfAborted(); options.signal.throwIfAborted(); options.validate(); };
    const { controllerBootId, nodeBootId, logicalSessionId } = this.#target.identity;
    this.#channel = new NodeBulkChannel({
      send: (payload) => { validate(); return port.send(this.#wrap(payload)); },
      sendWhenWritable: async (payload, signal, beforeSend) => {
        validate(); beforeSend?.();
        await port.sendWhenWritable(this.#wrap(payload), signal, () => { validate(); beforeSend?.(); });
        validate();
      },
      writable: async (signal) => { validate(); signal.throwIfAborted(); },
      close: () => this.close(),
    }, receiver, { session: { controllerBootId, nodeBootId, logicalSessionId }, signal: AbortSignal.any([options.signal, this.#closing.signal]),
      maxPendingRequests: 1, reservedCancelRequests: 1, scheduleTimeout: options.scheduleTimeout, validate });
  }

  receive(frame: NodeHistoryBulkFrame): void {
    if (this.#closing.signal.aborted) return;
    const parsed = parseNodeHistoryBulkText(JSON.stringify(frame));
    if (!parsed || !sameNodeHistoryBulkTarget(parsed, this.#target)) { this.close(); return; }
    const payload = parseNodeBulkFrameText(parsed.payload)!;
    if (isNodeBulkReply(payload) !== (this.options.side === 'sender')
      || payload.type === 'node-bulk-chunk') { this.close(); return; }
    this.#channel.receive(parsed.payload);
  }

  sendChunk(serialized: string, signal: AbortSignal): Promise<void> {
    if (this.options.side !== 'sender') return Promise.reject(unavailable());
    return this.#channel.sendChunkWithCredit(serialized, signal);
  }

  complete(identity: NodeBulkIdentity, signal: AbortSignal): Promise<void> {
    this.#assertGrant(identity);
    return this.#channel.complete(identity, signal);
  }

  cancel(identity: NodeBulkIdentity): Promise<void> {
    this.#assertGrant(identity);
    return this.#channel.cancel(identity);
  }

  close(): void {
    if (this.#closing.signal.aborted) return;
    this.#closing.abort(unavailable());
    this.#channel?.close();
    this.options.closed();
  }

  #assertGrant(value: NodeBulkIdentity): void {
    const grant = parseNodeBulkIdentity(value);
    if (this.options.side !== 'sender' || !grant || !sameNodeHistoryBulkTarget({ ...this.#target, grant }, this.#target)) throw unavailable();
  }

  #wrap(payload: string): NodeHistoryBulkFrame {
    const frame: NodeHistoryBulkFrame = { ...this.#target, type: 'node-history-bulk', version: NODE_WIRE_VERSION, payload };
    serializeNodeHistoryBulk(frame);
    const parsed = parseNodeBulkFrameText(payload)!;
    if (isNodeBulkReply(parsed) !== (this.options.side === 'receiver') || parsed.type === 'node-bulk-chunk') throw unavailable();
    return frame;
  }
}

function targetFields(target: NodeHistoryBulkTarget): NodeHistoryBulkTarget {
  return { identity: target.identity, instanceId: target.instanceId, connectionId: target.connectionId,
    bulkAttemptId: target.bulkAttemptId, sequence: target.sequence, grant: target.grant };
}

function unavailable(): NodeBulkError { return new NodeBulkError('NODE_BULK_UNAVAILABLE', 'History row transfer is unavailable'); }
