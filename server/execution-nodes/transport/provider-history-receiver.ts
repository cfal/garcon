import type { AgentImportedTranscriptRow } from '@garcon/server-agent-interface';
import { DEFAULT_NODE_BULK_LIMITS, NodeBulkError, NodeBulkTransfers, type NodeBulkTransfersOptions } from './bulk-transfers.js';
import type { NodeBulkDescriptor, NodeBulkIdentity } from './bulk-wire.js';
import { NodeHistoryBulkChannel, type NodeHistoryBulkPort } from './provider-history-bulk-channel.js';
import { sameNodeHistoryBulkTarget, type NodeHistoryBulkFrame, type NodeHistoryBulkTarget } from './provider-history-bulk-wire.js';
import type { NodeHistoryMemoryBudget } from './provider-history-memory.js';
import { decodeNodeHistoryRow } from './provider-history-row.js';
import type { NodeHistoryImportTarget } from './provider-history-wire.js';
import { nodeHistoryBulkLimits } from './provider-history-allocation.js';

export interface NodeHistoryRowReservation {
  readonly grant: NodeBulkIdentity;
  readonly verified: Promise<void>;
  take(): AgentImportedTranscriptRow;
  close(): void;
}

interface ReceivingRow {
  readonly target: NodeHistoryBulkTarget;
  readonly channel: NodeHistoryBulkChannel;
  discarded(): void;
}

/** Installs controller-owned grants before transfer dispatch; verification and caller consumption remain separate. */
export class NodeHistoryBulkReceiver {
  readonly #rows = new Map<string, ReceivingRow>();
  readonly #transfers: NodeBulkTransfers;
  readonly #closing = new AbortController();
  readonly #detach: () => void;
  readonly #maxRows: number;
  readonly #maxTransferBytes: number;

  constructor(private readonly memory: NodeHistoryMemoryBudget, private readonly options: NodeBulkTransfersOptions) {
    this.#maxRows = options.limits?.maxTransfers ?? DEFAULT_NODE_BULK_LIMITS.maxTransfers;
    const limits = { ...nodeHistoryBulkLimits(memory.maxBytes), ...options.limits };
    this.#maxTransferBytes = limits.maxTransferBytes;
    this.#transfers = new NodeBulkTransfers({ ...options, limits, authoritySignal: this.#closing.signal,
      discarded: (identity) => this.#rows.get(identity.transferId)?.discarded() });
    const close = () => this.close();
    this.#detach = () => options.authoritySignal.removeEventListener('abort', close);
    options.authoritySignal.addEventListener('abort', close, { once: true });
    if (options.authoritySignal.aborted) close();
  }

  reserve(importTarget: NodeHistoryImportTarget, sequence: number, descriptor: NodeBulkDescriptor, port: NodeHistoryBulkPort,
    caller: AbortSignal, validate: () => void): NodeHistoryRowReservation {
    const cancellation = new AbortController();
    const signal = AbortSignal.any([caller, this.#closing.signal, cancellation.signal]);
    signal.throwIfAborted(); validate();
    if (this.#rows.size >= this.#maxRows) throw new NodeBulkError('NODE_CAPACITY', 'History receiving rows are at capacity');
    if (descriptor.byteLength > this.#maxTransferBytes) throw new NodeBulkError('NODE_CAPACITY', 'History receiver allocation cannot carry this row');
    const owner = Object.freeze({});
    const verified = Promise.withResolvers<void>();
    void verified.promise.catch(() => {});
    const captured = Object.freeze({ ...descriptor });
    const buffer = this.memory.reserve(captured.byteLength);
    let grant: NodeBulkIdentity;
    try { grant = this.#transfers.reserve(owner, captured, signal); }
    catch (error) { buffer.release(); throw error; }
    const target = Object.freeze({ ...importTarget, identity: Object.freeze({ ...importTarget.identity }), sequence, grant });
    let channel: NodeHistoryBulkChannel | null = null;
    let complete = false;
    let taken = false;
    const close = () => {
      if (cancellation.signal.aborted) return;
      cancellation.abort(unavailable());
      caller.removeEventListener('abort', close);
      this.#closing.signal.removeEventListener('abort', close);
      this.#rows.delete(grant.transferId);
      verified.reject(unavailable());
      channel?.close();
      buffer.release();
    };
    try {
      channel = new NodeHistoryBulkChannel(port, {
        append: (identity, offset, bytes) => { this.#transfers.append(identity, offset, bytes); },
        complete: (identity) => {
          try { this.#transfers.complete(identity); complete = true; verified.resolve(); }
          catch (error) { verified.reject(error); throw error; }
        },
        cancel: (identity) => {
          this.#transfers.cancel(identity, owner); verified.reject(unavailable());
          // Lets the synchronous cancellation acknowledgement enter the physical writer first.
          queueMicrotask(close);
        },
      }, { ...target, side: 'receiver', signal, validate, closed: close });
      signal.throwIfAborted(); validate();
      this.#rows.set(grant.transferId, { target, channel, discarded: () => {
        buffer.release(); queueMicrotask(close);
      } });
      caller.addEventListener('abort', close, { once: true });
      this.#closing.signal.addEventListener('abort', close, { once: true });
      return Object.freeze({ grant, verified: verified.promise, close,
        take: () => {
          signal.throwIfAborted(); validate();
          if (!complete || taken) throw unavailable();
          let bytes: Uint8Array | null = null;
          try {
            bytes = this.#transfers.take(grant, owner); taken = true;
            return decodeNodeHistoryRow(bytes, this.memory);
          } finally { bytes?.fill(0); close(); }
        } });
    } catch (error) { close(); throw error; }
  }

  receive(frame: NodeHistoryBulkFrame): void {
    const row = this.#rows.get(frame.grant.transferId);
    if (row && sameNodeHistoryBulkTarget(row.target, frame)) row.channel.receive(frame);
  }

  get reservedBytes(): number { return this.#transfers.reservedBytes; }
  get transferCount(): number { return this.#transfers.transferCount; }

  close(): void {
    if (this.#closing.signal.aborted) return;
    this.#detach(); this.#closing.abort(unavailable()); this.#transfers.close();
  }
}

function unavailable(): NodeBulkError { return new NodeBulkError('NODE_BULK_UNAVAILABLE', 'History receiving grant is unavailable'); }
