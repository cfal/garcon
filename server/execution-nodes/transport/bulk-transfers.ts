import { createHash, randomUUID, type Hash } from 'node:crypto';
import { parseNodeSessionIdentity, sameNodeSession, type NodeSessionIdentity } from '../../../common/node-operation.js';
import { MAX_NODE_BULK_CHUNK_BYTES, parseNodeBulkDescriptor, parseNodeBulkIdentity, type NodeBulkDescriptor, type NodeBulkIdentity } from './bulk-wire.js';

export interface NodeBulkLimits {
  readonly maxTransfers: number;
  readonly maxBytes: number;
  readonly maxTransferBytes: number;
  readonly retentionMs: number;
}

export const DEFAULT_NODE_BULK_LIMITS: NodeBulkLimits = Object.freeze({
  maxTransfers: 32, maxBytes: 128 * 1024 * 1024,
  // Accommodates the complete image budget after base64 and JSON encoding.
  maxTransferBytes: 64 * 1024 * 1024, retentionMs: 30_000,
});

export interface NodeBulkStatus {
  readonly identity: NodeBulkIdentity;
  readonly descriptor: NodeBulkDescriptor;
  readonly receivedBytes: number;
  readonly phase: 'receiving' | 'complete';
}

export class NodeBulkError extends Error {
  constructor(readonly code: 'NODE_BULK_UNAVAILABLE' | 'NODE_BULK_INVALID' | 'NODE_CAPACITY', message: string) {
    super(message);
    this.name = 'NodeBulkError';
  }
}

interface Transfer {
  readonly identity: NodeBulkIdentity;
  readonly owner: object;
  readonly descriptor: NodeBulkDescriptor;
  readonly bytes: Uint8Array;
  expiresAt: number;
  readonly detach: () => void;
  timer: { cancel(): void };
  hash: Hash | null;
  received: number;
}

export interface NodeBulkTransfersOptions {
  readonly session: NodeSessionIdentity;
  readonly authoritySignal: AbortSignal;
  readonly limits?: Partial<NodeBulkLimits>;
  readonly now?: () => number;
  readonly scheduleTimeout?: (callback: () => void, delay: number) => { cancel(): void };
  /** Releases outer ownership when a grant is discarded, including expiry; take transfers ownership instead. */
  readonly discarded?: (identity: NodeBulkIdentity) => void;
}

/** Receives private bytes under locally installed grants; wire handlers still authenticate each physical channel. */
export class NodeBulkTransfers {
  readonly #session: NodeSessionIdentity;
  readonly #limits: NodeBulkLimits;
  readonly #transfers = new Map<string, Transfer>();
  readonly #detachAuthority: () => void;
  #reservedBytes = 0;
  #lastTime = 0;
  #closed = false;

  constructor(private readonly options: NodeBulkTransfersOptions) {
    const session = parseNodeSessionIdentity(options.session);
    if (!session) throw new TypeError('Invalid bulk transfer session');
    this.#session = Object.freeze(session);
    this.#limits = { ...DEFAULT_NODE_BULK_LIMITS, ...options.limits };
    if (Object.values(this.#limits).some((value) => !Number.isSafeInteger(value) || value < 1)
      || this.#limits.maxTransferBytes > this.#limits.maxBytes) throw new TypeError('Invalid bulk transfer limits');
    const close = () => this.close();
    options.authoritySignal.addEventListener('abort', close, { once: true });
    this.#detachAuthority = () => options.authoritySignal.removeEventListener('abort', close);
    if (options.authoritySignal.aborted) this.close();
  }

  reserve(owner: object, value: NodeBulkDescriptor, signal: AbortSignal): NodeBulkIdentity {
    const now = this.#poll();
    if (this.#closed) throw unavailable();
    signal.throwIfAborted();
    const descriptor = parseNodeBulkDescriptor(value);
    if (!descriptor || descriptor.byteLength > this.#limits.maxTransferBytes) throw invalid();
    if (this.#transfers.size >= this.#limits.maxTransfers || descriptor.byteLength > this.#limits.maxBytes - this.#reservedBytes) {
      throw new NodeBulkError('NODE_CAPACITY', 'Node bulk transfer capacity is reserved');
    }
    const identity = Object.freeze({ ...this.#session, transferId: randomUUID() });
    const cancel = () => { this.#discard(identity.transferId); };
    const transfer: Transfer = {
      identity, owner, descriptor: Object.freeze(descriptor), bytes: new Uint8Array(descriptor.byteLength),
      expiresAt: now + this.#limits.retentionMs, received: 0, hash: createHash('sha256'),
      detach: () => signal.removeEventListener('abort', cancel),
      timer: (this.options.scheduleTimeout ?? scheduleTimeout)(() => {
        try { this.prune(); } catch { this.close(); }
      }, this.#limits.retentionMs),
    };
    this.#transfers.set(identity.transferId, transfer);
    this.#reservedBytes += descriptor.byteLength;
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) { cancel(); signal.throwIfAborted(); }
    return identity;
  }

  append(identity: NodeBulkIdentity, offset: number, input: Uint8Array): number {
    const transfer = this.#require(identity);
    if (!transfer.hash || !Number.isSafeInteger(offset) || offset !== transfer.received
      || !input.byteLength || input.byteLength > MAX_NODE_BULK_CHUNK_BYTES || input.byteLength > transfer.bytes.byteLength - offset) throw invalid();
    const bytes = Uint8Array.from(input);
    transfer.bytes.set(bytes, offset);
    transfer.hash.update(bytes);
    transfer.received += bytes.byteLength;
    this.#renew(transfer);
    return transfer.received;
  }

  complete(identity: NodeBulkIdentity): NodeBulkStatus {
    const transfer = this.#require(identity);
    if (!transfer.hash) return snapshot(transfer);
    if (transfer.received !== transfer.descriptor.byteLength) throw invalid();
    if (transfer.hash.digest('hex') !== transfer.descriptor.sha256) {
      this.#discard(identity.transferId);
      throw invalid();
    }
    transfer.hash = null;
    this.#renew(transfer);
    return snapshot(transfer);
  }

  take(identity: NodeBulkIdentity, owner: object): Uint8Array {
    const transfer = this.#require(identity);
    if (transfer.owner !== owner) throw unavailable();
    if (transfer.hash) throw invalid();
    this.#remove(transfer);
    return transfer.bytes;
  }

  cancel(identity: NodeBulkIdentity, owner: object): void {
    const transfer = this.#lookup(identity);
    if (!transfer) return;
    if (transfer.owner !== owner) throw unavailable();
    this.#discard(identity.transferId);
  }

  status(identity: NodeBulkIdentity): NodeBulkStatus | null {
    const transfer = this.#lookup(identity);
    return transfer ? snapshot(transfer) : null;
  }

  prune(): void { this.#poll(); }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#detachAuthority();
    for (const id of this.#transfers.keys()) this.#discard(id);
  }

  get reservedBytes(): number { this.#poll(); return this.#reservedBytes; }
  get transferCount(): number { this.#poll(); return this.#transfers.size; }

  #lookup(value: NodeBulkIdentity): Transfer | null {
    const identity = parseNodeBulkIdentity(value);
    if (!identity || !sameNodeSession(identity, this.#session)) throw unavailable();
    this.#poll();
    if (this.#closed) throw unavailable();
    return this.#transfers.get(identity.transferId) ?? null;
  }

  #require(identity: NodeBulkIdentity): Transfer {
    const transfer = this.#lookup(identity);
    if (!transfer) throw unavailable();
    return transfer;
  }

  #poll(): number {
    const now = (this.options.now ?? (() => performance.now()))();
    if (!Number.isFinite(now) || now < this.#lastTime || now < 0) {
      this.close();
      throw unavailable();
    }
    this.#lastTime = now;
    for (const [id, transfer] of this.#transfers) if (now >= transfer.expiresAt) this.#discard(id);
    return now;
  }

  #discard(id: string): void {
    const transfer = this.#transfers.get(id);
    if (!transfer) return;
    transfer.bytes.fill(0);
    transfer.hash = null;
    this.#remove(transfer);
    this.options.discarded?.(transfer.identity);
  }

  #renew(transfer: Transfer): void {
    transfer.expiresAt = this.#lastTime + this.#limits.retentionMs;
    transfer.timer.cancel();
    transfer.timer = (this.options.scheduleTimeout ?? scheduleTimeout)(() => {
      try { this.prune(); } catch { this.close(); }
    }, this.#limits.retentionMs);
  }

  #remove(transfer: Transfer): void {
    this.#transfers.delete(transfer.identity.transferId);
    this.#reservedBytes -= transfer.descriptor.byteLength;
    transfer.timer.cancel();
    transfer.detach();
  }
}

function snapshot(transfer: Transfer): NodeBulkStatus {
  return Object.freeze({ identity: transfer.identity, descriptor: transfer.descriptor,
    receivedBytes: transfer.received, phase: transfer.hash ? 'receiving' : 'complete' });
}

function unavailable(): NodeBulkError { return new NodeBulkError('NODE_BULK_UNAVAILABLE', 'The node bulk transfer grant is unavailable'); }
function invalid(): NodeBulkError { return new NodeBulkError('NODE_BULK_INVALID', 'Invalid or incomplete node bulk transfer'); }
function scheduleTimeout(callback: () => void, delay: number): { cancel(): void } {
  const timer = setTimeout(callback, delay);
  timer.unref();
  return { cancel: () => clearTimeout(timer) };
}
