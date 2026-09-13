import type { NodeSessionIdentity } from '../../../common/node-operation.js';
import { parseNodeBulkFrameText } from './bulk-channel-wire.js';
import { NodeBulkError } from './bulk-transfers.js';
import { NodeBulkUploads, type NodeBulkUploadsOptions } from './bulk-upload.js';
import type { NodeBulkDescriptor, NodeBulkIdentity } from './bulk-wire.js';
import { NodeHistoryBulkChannel, type NodeHistoryBulkChannelOptions, type NodeHistoryBulkPort } from './provider-history-bulk-channel.js';
import { sameNodeHistoryBulkTarget, type NodeHistoryBulkFrame, type NodeHistoryBulkTarget } from './provider-history-bulk-wire.js';
import { nodeHistoryBulkLimits } from './provider-history-allocation.js';
import type { NodeHistoryMemoryBudget } from './provider-history-memory.js';

interface HistorySend {
  readonly target: NodeHistoryBulkTarget;
  readonly channel: NodeHistoryBulkChannel;
}

export interface NodeHistorySenderOptions {
  readonly session: NodeSessionIdentity;
  readonly signal: AbortSignal;
  readonly memory: NodeHistoryMemoryBudget;
  readonly limits?: NodeBulkUploadsOptions['limits'];
  readonly scheduleTimeout?: NodeHistoryBulkChannelOptions['scheduleTimeout'];
}

/** Shares upload snapshots across cursors; each row retains its exact receiving grant and physical authority. */
export class NodeHistoryBulkSender {
  readonly #rows = new Map<string, HistorySend>();
  readonly #uploads: NodeBulkUploads;
  readonly #closing = new AbortController();
  readonly #detach: () => void;
  readonly #maxTransferBytes: number;

  constructor(private readonly port: NodeHistoryBulkPort, private readonly options: NodeHistorySenderOptions) {
    const limits = { ...nodeHistoryBulkLimits(options.memory.maxBytes), ...options.limits };
    this.#maxTransferBytes = limits.maxTransferBytes;
    this.#uploads = new NodeBulkUploads({
      reserve: async () => { throw unavailable(); },
      sendChunk: async (serialized, signal) => {
        const frame = parseNodeBulkFrameText(serialized);
        if (frame?.type !== 'node-bulk-chunk') throw unavailable();
        await this.#row(frame.transfer).channel.sendChunk(serialized, signal);
      },
      complete: (identity, signal) => this.#row(identity).channel.complete(identity, signal),
      cancel: (identity) => this.#row(identity).channel.cancel(identity),
    }, { session: options.session, authoritySignal: this.#closing.signal, limits });
    const close = () => this.close();
    this.#detach = () => options.signal.removeEventListener('abort', close);
    options.signal.addEventListener('abort', close, { once: true });
    if (options.signal.aborted) close();
  }

  async transfer(target: NodeHistoryBulkTarget, descriptor: NodeBulkDescriptor, bytes: Uint8Array,
    caller: AbortSignal, validate: () => void): Promise<void> {
    const signal = AbortSignal.any([caller, this.#closing.signal]);
    signal.throwIfAborted(); validate();
    if (this.#rows.has(target.grant.transferId)) throw new NodeBulkError('NODE_BULK_INVALID', 'History transfer grant is already in use');
    if (bytes.byteLength > this.#maxTransferBytes) throw new NodeBulkError('NODE_CAPACITY', 'History sender allocation cannot carry this row');
    const copy = this.options.memory.reserve(bytes.byteLength);
    const cancellation = new AbortController();
    const lifetime = AbortSignal.any([signal, cancellation.signal]);
    let channel: NodeHistoryBulkChannel;
    try { channel = new NodeHistoryBulkChannel(this.port, {
      append() { throw unavailable(); }, complete() { throw unavailable(); }, cancel() { throw unavailable(); },
    }, { ...target, side: 'sender', signal: lifetime, validate, scheduleTimeout: this.options.scheduleTimeout,
      closed: () => cancellation.abort(unavailable()) }); }
    catch (error) { copy.release(); throw error; }
    const row = { target: Object.freeze({ ...target, identity: Object.freeze({ ...target.identity }), grant: Object.freeze({ ...target.grant }) }), channel };
    this.#rows.set(target.grant.transferId, row);
    try {
      await this.#uploads.uploadReserved(bytes, row.target.grant, descriptor, lifetime);
      lifetime.throwIfAborted(); validate();
    } catch (error) {
      caller.throwIfAborted();
      throw error;
    } finally {
      this.#rows.delete(row.target.grant.transferId);
      channel.close();
      copy.release();
    }
  }

  receive(frame: NodeHistoryBulkFrame): void {
    const row = this.#rows.get(frame.grant.transferId);
    if (row && sameNodeHistoryBulkTarget(row.target, frame)) row.channel.receive(frame);
  }

  close(): void {
    if (this.#closing.signal.aborted) return;
    this.#detach(); this.#closing.abort(unavailable());
    for (const row of this.#rows.values()) row.channel.close();
  }

  #row(identity: NodeBulkIdentity): HistorySend {
    this.#closing.signal.throwIfAborted();
    const row = this.#rows.get(identity.transferId);
    if (!row) throw unavailable();
    return row;
  }
}

function unavailable(): NodeBulkError { return new NodeBulkError('NODE_BULK_UNAVAILABLE', 'History row sender is unavailable'); }
