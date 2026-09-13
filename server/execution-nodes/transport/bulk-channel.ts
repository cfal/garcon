import { NODE_WIRE_VERSION } from '@garcon/server-agent-interface';
import { parseNodeSessionIdentity, sameNodeSession, type NodeSessionIdentity } from '../../../common/node-operation.js';
import { NodeBulkError } from './bulk-transfers.js';
import { parseNodeBulkChunkText, parseNodeBulkIdentity, type NodeBulkIdentity } from './bulk-wire.js';
import { parseNodeBulkFrameText, serializeNodeBulkFrame, type NodeBulkCommand, type NodeBulkReply } from './bulk-channel-wire.js';
import { NodeSocketWriteError, type NodeSocketWriter } from './socket-writer.js';

export interface NodeBulkReceivePort {
  append(identity: NodeBulkIdentity, offset: number, bytes: Uint8Array): void;
  complete(identity: NodeBulkIdentity): void;
  cancel(identity: NodeBulkIdentity): void;
}

export interface NodeBulkChannelOptions {
  readonly session: NodeSessionIdentity;
  readonly signal: AbortSignal;
  readonly maxPendingRequests?: number;
  readonly reservedCancelRequests?: number;
  readonly requestTimeoutMs?: number;
  readonly scheduleTimeout?: (callback: () => void, delayMs: number) => { cancel(): void };
  /** Checks the exact authenticated physical channel and its logical authority. */
  validate(): void;
}

interface PendingRequest {
  readonly expected: 'completed' | 'cancelled';
  readonly result: PromiseWithResolvers<void>;
  readonly detach: () => void;
  readonly timer: { cancel(): void };
}

interface ChunkCredit {
  readonly nextOffset: number;
  readonly result: PromiseWithResolvers<void>;
  readonly cancellation: AbortController;
  readonly detach: () => void;
  readonly timer: { cancel(): void };
}

interface OutgoingTransfer {
  failure: NodeBulkError | null;
  throughOffset: number;
  credit: ChunkCredit | null;
}

/** Transfers only pre-reserved bodies; grants are installed through the authenticated control channel. */
export class NodeBulkChannel {
  readonly #session: NodeSessionIdentity;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #outgoing = new Map<string, OutgoingTransfer>();
  readonly #maxPending: number;
  readonly #reservedCancels: number;
  readonly #timeoutMs: number;
  readonly #detach: () => void;
  readonly #sent = { 'node-bulk-complete': 0, 'node-bulk-cancel': 0 };
  // Cancellation may pass completion queued behind data on an intermediate worker hop.
  readonly #received = { 'node-bulk-complete': 0, 'node-bulk-cancel': 0 };
  #closed = false;

  constructor(
    private readonly writer: Pick<NodeSocketWriter, 'send' | 'sendWhenWritable' | 'writable' | 'close'>,
    private readonly receiver: NodeBulkReceivePort,
    private readonly options: NodeBulkChannelOptions,
  ) {
    const session = parseNodeSessionIdentity(options.session);
    if (!session) throw new TypeError('Invalid node bulk channel session');
    this.#session = Object.freeze(session);
    this.#maxPending = options.maxPendingRequests ?? 32;
    this.#reservedCancels = options.reservedCancelRequests ?? 4;
    this.#timeoutMs = options.requestTimeoutMs ?? 10_000;
    if (![this.#maxPending, this.#reservedCancels, this.#maxPending + this.#reservedCancels, this.#timeoutMs]
      .every((n) => Number.isSafeInteger(n) && n > 0)) throw new TypeError('Invalid bulk channel limits');
    const close = () => this.close();
    options.signal.addEventListener('abort', close, { once: true });
    this.#detach = () => options.signal.removeEventListener('abort', close);
    if (options.signal.aborted) this.close();
  }

  async sendChunk(serialized: string, signal: AbortSignal): Promise<void> {
    this.#validate();
    signal.throwIfAborted();
    const chunk = parseNodeBulkChunkText(serialized);
    if (!chunk || !sameNodeSession(chunk.transfer, this.#session)) throw invalid();
    let outgoing = this.#outgoing.get(chunk.transfer.transferId);
    if (!outgoing) {
      if (this.#outgoing.size >= this.#maxPending) throw new NodeBulkError('NODE_CAPACITY', 'Node bulk transfers are at capacity');
      outgoing = { failure: null, throughOffset: 0, credit: null };
      this.#outgoing.set(chunk.transfer.transferId, outgoing);
    }
    if (outgoing.credit) throw invalid();
    const credit = chunk.type === 'node-bulk-credit-chunk' ? this.#reserveCredit(outgoing, chunk.offset, chunk.data, signal) : null;
    const sending = credit ? AbortSignal.any([signal, credit.cancellation.signal]) : signal;
    try {
      if (outgoing.failure) throw outgoing.failure;
      await this.writer.sendWhenWritable(serialized, sending, () => {
        this.#validate();
        if (outgoing.failure) throw outgoing.failure;
      });
      await this.writer.writable(sending);
      this.#validate();
      signal.throwIfAborted();
      if (outgoing.failure) throw outgoing.failure;
      await credit?.result.promise;
      this.#validate(); signal.throwIfAborted();
      if (outgoing.failure) throw outgoing.failure;
    } catch (error) {
      if (credit) this.#failOutgoing(outgoing, unavailable(), error);
      if (error instanceof NodeSocketWriteError && error.code === 'NODE_SOCKET_CAPACITY') {
        throw new NodeBulkError('NODE_CAPACITY', 'Node bulk writers are at capacity');
      }
      if (error instanceof NodeSocketWriteError || !signal.aborted && !(error instanceof NodeBulkError)) this.close();
      throw error;
    }
  }

  /** Waits for the receiving endpoint to append this chunk before allowing another chunk. */
  sendChunkWithCredit(serialized: string, signal: AbortSignal): Promise<void> {
    const chunk = parseNodeBulkChunkText(serialized);
    if (!chunk) return Promise.reject(invalid());
    return this.sendChunk(serializeNodeBulkFrame({ ...chunk, type: 'node-bulk-credit-chunk' }), signal);
  }

  async complete(identity: NodeBulkIdentity, signal: AbortSignal): Promise<void> {
    const transfer = this.#transfer(identity);
    const outgoing = this.#outgoing.get(transfer.transferId);
    if (outgoing?.credit) throw invalid();
    try {
      if (outgoing?.failure) throw outgoing.failure;
      await this.#request('node-bulk-complete', transfer, signal);
      if (outgoing?.failure) throw outgoing.failure;
    } finally { this.#outgoing.delete(transfer.transferId); }
  }

  async cancel(identity: NodeBulkIdentity): Promise<void> {
    const transfer = this.#transfer(identity);
    const outgoing = this.#outgoing.get(transfer.transferId);
    if (outgoing) this.#failOutgoing(outgoing, unavailable());
    this.#outgoing.delete(transfer.transferId);
    await this.#request('node-bulk-cancel', transfer, this.options.signal);
  }

  /** Invalid input closes this physical bulk socket without throwing into the WebSocket callback. */
  receive(serialized: string): void {
    if (this.#closed) return;
    try {
      this.#validate();
      const frame = parseNodeBulkFrameText(serialized);
      if (!frame || !sameNodeSession(frame.type === 'node-bulk-result' ? frame.session : frame.transfer, this.#session)) throw invalid();
      if (frame.type === 'node-bulk-result') {
        if (frame.requestId > this.#sent[frame.command]) throw invalid();
        const key = requestKey(frame.command, frame.requestId);
        const pending = this.#pending.get(key);
        if (!pending) return;
        if (frame.result === pending.expected) this.#settle(key);
        else if (frame.result === 'NODE_BULK_INVALID' || frame.result === 'NODE_BULK_UNAVAILABLE') {
          this.#settle(key, new NodeBulkError(frame.result, 'Node rejected the bulk transfer'));
        } else throw invalid();
      } else if (frame.type === 'node-bulk-chunk-ack') {
        const outgoing = this.#outgoing.get(frame.transfer.transferId);
        if (!outgoing || outgoing.failure || frame.nextOffset <= outgoing.throughOffset) return;
        if (!outgoing.credit || frame.nextOffset !== outgoing.credit.nextOffset) throw invalid();
        outgoing.throughOffset = frame.nextOffset;
        this.#settleCredit(outgoing);
      } else if (frame.type === 'node-bulk-failed') {
        const outgoing = this.#outgoing.get(frame.transfer.transferId);
        if (outgoing) this.#failOutgoing(outgoing, new NodeBulkError(frame.code, 'Node rejected the bulk transfer'));
      } else if (frame.type === 'node-bulk-chunk' || frame.type === 'node-bulk-credit-chunk') {
        try {
          const bytes = Buffer.from(frame.data, 'base64');
          this.receiver.append(frame.transfer, frame.offset, bytes);
          if (frame.type === 'node-bulk-credit-chunk') {
            this.#validate();
            // Refused ACK admission is a lost reply, not permission to retire the shared worker.
            this.writer.send(serializeNodeBulkFrame({ type: 'node-bulk-chunk-ack', version: NODE_WIRE_VERSION,
              transfer: frame.transfer, nextOffset: frame.offset + bytes.byteLength }));
          }
        }
        catch (error) {
          const code = error instanceof NodeBulkError && error.code === 'NODE_BULK_INVALID' ? error.code : 'NODE_BULK_UNAVAILABLE';
          this.#validate();
          this.writer.send(serializeNodeBulkFrame({ type: 'node-bulk-failed', version: NODE_WIRE_VERSION, transfer: frame.transfer, code }));
        }
      } else {
        if (frame.requestId <= this.#received[frame.type]) throw invalid();
        this.#received[frame.type] = frame.requestId;
        this.#receiveCommand(frame);
      }
    } catch { this.close(); }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#detach();
    for (const key of this.#pending.keys()) this.#settle(key, unavailable());
    for (const outgoing of this.#outgoing.values()) this.#failOutgoing(outgoing, unavailable());
    this.#outgoing.clear();
    this.writer.close();
  }

  async #request(type: NodeBulkCommand['type'], value: NodeBulkIdentity, signal: AbortSignal): Promise<void> {
    this.#validate();
    signal.throwIfAborted();
    const transfer = parseNodeBulkIdentity(value);
    if (!transfer || !sameNodeSession(transfer, this.#session)) throw invalid();
    const completing = [...this.#pending.values()].filter((pending) => pending.expected === 'completed').length;
    if (this.#pending.size >= this.#maxPending + this.#reservedCancels || type === 'node-bulk-complete' && completing >= this.#maxPending) {
      throw new NodeBulkError('NODE_CAPACITY', 'Node bulk requests are at capacity');
    }
    if (this.#sent[type] === Number.MAX_SAFE_INTEGER) { this.close(); throw unavailable(); }
    const requestId = ++this.#sent[type];
    const key = requestKey(type, requestId);
    const cancel = () => this.#settle(key, signal.reason);
    const pending: PendingRequest = {
      expected: type === 'node-bulk-complete' ? 'completed' : 'cancelled', result: Promise.withResolvers<void>(),
      detach: () => signal.removeEventListener('abort', cancel),
      timer: (this.options.scheduleTimeout ?? scheduleTimeout)(() => this.#settle(key, unavailable()), this.#timeoutMs),
    };
    this.#pending.set(key, pending);
    signal.addEventListener('abort', cancel, { once: true });
    try {
      signal.throwIfAborted();
      if (!this.writer.send(serializeNodeBulkFrame({ type, version: NODE_WIRE_VERSION, transfer, requestId }))) {
        this.#settle(key, new NodeBulkError('NODE_CAPACITY', 'Node bulk writes are at capacity'));
      }
    } catch { this.close(); }
    return pending.result.promise;
  }

  #receiveCommand(frame: NodeBulkCommand): void {
    let result: NodeBulkReply['result'];
    try {
      if (frame.type === 'node-bulk-complete') { this.receiver.complete(frame.transfer); result = 'completed'; }
      else { this.receiver.cancel(frame.transfer); result = 'cancelled'; }
    } catch (error) {
      result = error instanceof NodeBulkError && error.code === 'NODE_BULK_INVALID' ? 'NODE_BULK_INVALID' : 'NODE_BULK_UNAVAILABLE';
    }
    this.#validate();
    this.writer.send(serializeNodeBulkFrame({ type: 'node-bulk-result', version: NODE_WIRE_VERSION,
      session: this.#session, command: frame.type, requestId: frame.requestId, result }));
  }

  #settle(key: string, error?: unknown): void {
    const pending = this.#pending.get(key);
    if (!pending) return;
    this.#pending.delete(key);
    pending.timer.cancel();
    pending.detach();
    if (error === undefined) pending.result.resolve();
    else pending.result.reject(error);
  }

  #reserveCredit(outgoing: OutgoingTransfer, offset: number, data: string, signal: AbortSignal): ChunkCredit {
    if (outgoing.failure) throw outgoing.failure;
    if (outgoing.throughOffset !== offset) throw invalid();
    const nextOffset = offset + data.length / 4 * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
    if (!Number.isSafeInteger(nextOffset)) throw invalid();
    const cancel = () => this.#failOutgoing(outgoing, unavailable(), signal.reason);
    const credit: ChunkCredit = { nextOffset, result: Promise.withResolvers<void>(), cancellation: new AbortController(),
      detach: () => signal.removeEventListener('abort', cancel),
      timer: (this.options.scheduleTimeout ?? scheduleTimeout)(() => this.#failOutgoing(outgoing, unavailable()), this.#timeoutMs) };
    outgoing.credit = credit;
    signal.addEventListener('abort', cancel, { once: true });
    void credit.result.promise.catch(() => {});
    return credit;
  }

  #failOutgoing(outgoing: OutgoingTransfer, error: NodeBulkError, reason: unknown = error): void {
    outgoing.failure = error;
    this.#settleCredit(outgoing, reason);
  }

  #settleCredit(outgoing: OutgoingTransfer, error?: unknown): void {
    const credit = outgoing.credit;
    if (!credit) return;
    outgoing.credit = null; credit.timer.cancel(); credit.detach();
    if (error === undefined) credit.result.resolve();
    else { credit.cancellation.abort(error); credit.result.reject(error); }
  }

  #validate(): void {
    if (this.#closed || this.options.signal.aborted) throw unavailable();
    try { this.options.validate(); }
    catch { this.close(); throw unavailable(); }
    if (this.#closed || this.options.signal.aborted) throw unavailable();
  }

  #transfer(value: NodeBulkIdentity): NodeBulkIdentity {
    this.#validate();
    const identity = parseNodeBulkIdentity(value);
    if (!identity || !sameNodeSession(identity, this.#session)) throw invalid();
    return identity;
  }
}

function requestKey(command: NodeBulkCommand['type'], requestId: number): string { return `${command}:${requestId}`; }
function invalid(): NodeBulkError { return new NodeBulkError('NODE_BULK_INVALID', 'Invalid node bulk message'); }
function unavailable(): NodeBulkError { return new NodeBulkError('NODE_BULK_UNAVAILABLE', 'The node bulk channel is unavailable'); }
function scheduleTimeout(callback: () => void, delayMs: number): { cancel(): void } {
  const timer = setTimeout(callback, delayMs);
  timer.unref();
  return { cancel: () => clearTimeout(timer) };
}
