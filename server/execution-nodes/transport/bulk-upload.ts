import { createHash } from 'node:crypto';
import { parseNodeSessionIdentity, sameNodeSession, type NodeSessionIdentity } from '../../../common/node-operation.js';
import { MAX_NODE_BULK_CHUNK_BYTES, parseNodeBulkDescriptor, parseNodeBulkIdentity, serializeNodeBulkChunk, type NodeBulkDescriptor, type NodeBulkIdentity } from './bulk-wire.js';
import { DEFAULT_NODE_BULK_LIMITS, NodeBulkError, type NodeBulkLimits } from './bulk-transfers.js';

export interface NodeBulkUploadPort {
  reserve(descriptor: NodeBulkDescriptor, signal: AbortSignal): Promise<NodeBulkIdentity>;
  /** Settles after local backpressure permits the next chunk; never queues an unbounded body. */
  sendChunk(serialized: string, signal: AbortSignal): Promise<void>;
  complete(identity: NodeBulkIdentity, signal: AbortSignal): Promise<void>;
  cancel(identity: NodeBulkIdentity): Promise<void>;
}

type UploadLimits = Pick<NodeBulkLimits, 'maxTransfers' | 'maxBytes' | 'maxTransferBytes'>;

export interface NodeBulkUploadsOptions {
  readonly session: NodeSessionIdentity;
  readonly authoritySignal: AbortSignal;
  readonly limits?: Partial<UploadLimits>;
}

/** Bounds sender-owned snapshots and never retries a transfer after a lost physical reply. */
export class NodeBulkUploads {
  readonly #limits: UploadLimits;
  readonly #session: NodeSessionIdentity;
  #count = 0;
  #bytes = 0;

  constructor(
    private readonly port: NodeBulkUploadPort,
    private readonly options: NodeBulkUploadsOptions,
  ) {
    const session = parseNodeSessionIdentity(options.session);
    if (!session) throw new TypeError('Invalid bulk upload session');
    this.#session = Object.freeze(session);
    this.#limits = { maxTransfers: DEFAULT_NODE_BULK_LIMITS.maxTransfers,
      maxBytes: DEFAULT_NODE_BULK_LIMITS.maxBytes, maxTransferBytes: DEFAULT_NODE_BULK_LIMITS.maxTransferBytes, ...options.limits };
    if (Object.values(this.#limits).some((value) => !Number.isSafeInteger(value) || value < 1)
      || this.#limits.maxTransferBytes > this.#limits.maxBytes) throw new TypeError('Invalid bulk upload limits');
  }

  async upload(bytes: Uint8Array, callerSignal: AbortSignal): Promise<{ readonly identity: NodeBulkIdentity; readonly descriptor: NodeBulkDescriptor }> {
    return this.#upload(bytes, callerSignal, (descriptor, signal) => this.port.reserve(descriptor, signal));
  }

  /** Uses a destination grant installed before dispatch while sharing ordinary upload capacity and settlement. */
  async uploadReserved(bytes: Uint8Array, value: NodeBulkIdentity, expected: NodeBulkDescriptor, callerSignal: AbortSignal): Promise<void> {
    const identity = parseNodeBulkIdentity(value);
    const descriptor = parseNodeBulkDescriptor(expected);
    if (!identity || !sameNodeSession(identity, this.#session) || !descriptor || descriptor.byteLength !== bytes.byteLength) {
      throw new NodeBulkError('NODE_BULK_INVALID', 'Invalid reserved upload destination');
    }
    await this.#upload(bytes, callerSignal, async (captured) => {
      if (captured.byteLength !== descriptor.byteLength || captured.sha256 !== descriptor.sha256) {
        throw new NodeBulkError('NODE_BULK_INVALID', 'Reserved upload differs from its descriptor');
      }
      return identity;
    });
  }

  async #upload(bytes: Uint8Array, callerSignal: AbortSignal, reserve: NodeBulkUploadPort['reserve']): Promise<{
    readonly identity: NodeBulkIdentity; readonly descriptor: NodeBulkDescriptor;
  }> {
    const signal = AbortSignal.any([this.options.authoritySignal, callerSignal]);
    signal.throwIfAborted();
    const length = bytes.byteLength;
    if (length > this.#limits.maxTransferBytes) throw new RangeError('Node bulk upload exceeds its limit');
    if (this.#count >= this.#limits.maxTransfers || length > this.#limits.maxBytes - this.#bytes) {
      throw new NodeBulkError('NODE_CAPACITY', 'Node bulk upload capacity is reserved');
    }
    this.#count += 1;
    this.#bytes += length;
    let captured: Uint8Array | null = null;
    let identity: NodeBulkIdentity | null = null;
    try {
      captured = Uint8Array.from(bytes);
      const descriptor = Object.freeze({ byteLength: length, sha256: createHash('sha256').update(captured).digest('hex') });
      const reserved = await reserve(descriptor, signal);
      const parsed = parseNodeBulkIdentity(reserved);
      if (!parsed || !sameNodeSession(parsed, this.#session)) throw new TypeError('Invalid bulk reservation reply');
      identity = Object.freeze(parsed);
      signal.throwIfAborted();
      for (let offset = 0; offset < length; offset += MAX_NODE_BULK_CHUNK_BYTES) {
        await this.port.sendChunk(serializeNodeBulkChunk(identity, offset, captured.subarray(offset, offset + MAX_NODE_BULK_CHUNK_BYTES)), signal);
        // Gives control sockets and lease checks a turn even when a bulk send completes inline.
        await new Promise<void>((resolve) => setImmediate(resolve));
        signal.throwIfAborted();
      }
      await this.port.complete(identity, signal);
      signal.throwIfAborted();
      return { identity, descriptor };
    } catch (error) {
      if (identity) {
        try { await this.port.cancel(identity); }
        catch { /* Receiver grant retirement and expiry own cleanup after a lost cancellation reply. */ }
      }
      throw error;
    } finally {
      captured?.fill(0);
      this.#count -= 1;
      this.#bytes -= length;
    }
  }
}
