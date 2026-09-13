import { createHash } from 'node:crypto';
import type { AgentImportedTranscriptRow } from '@garcon/server-agent-interface';
import { NodeDeadline } from '../execution-nodes/deadline.js';
import { PROVIDER_HISTORY_IMPORT_MAX_BATCH_ROWS, type ProviderHistoryImportRequest, type ProviderHistoryImportService } from '../execution-nodes/provider-history-import.js';
import type { NodeBulkDescriptor, NodeBulkIdentity } from '../execution-nodes/transport/bulk-wire.js';
import { encodeNodeHistoryRow, NODE_HISTORY_ROW_ENCODING, type EncodedNodeHistoryRow } from '../execution-nodes/transport/provider-history-row.js';
import type { NodeHistoryMemoryBudget } from '../execution-nodes/transport/provider-history-memory.js';
import type { LeaseClock } from './lease-clock.js';

export type NodeHistoryCursorNext =
  | { readonly kind: 'row'; readonly sequence: number; readonly encoding: typeof NODE_HISTORY_ROW_ENCODING; readonly descriptor: NodeBulkDescriptor }
  | { readonly kind: 'eof'; readonly sequence: number };

export interface NodeHistoryCursorSettlement {
  readonly kind: 'complete' | 'cancelled' | 'failed';
  readonly error?: unknown;
}

export interface NodeHistoryCursorOptions {
  readonly source: ProviderHistoryImportService;
  readonly request: ProviderHistoryImportRequest;
  readonly signal: AbortSignal;
  readonly memory: NodeHistoryMemoryBudget;
  readonly idleTimeoutMs?: number;
  createClock?(): LeaseClock;
  scheduleTimeout?(callback: () => void, delay: number): { cancel(): void };
  release(): void;
  transfer(bytes: Uint8Array, sequence: number, grant: NodeBulkIdentity, descriptor: NodeBulkDescriptor, signal: AbortSignal, deadline: NodeDeadline): Promise<void>;
}

/** Owns the iterator independently of RPC waits and retains capacity through actual cleanup. */
export class NodeHistoryImportCursor {
  readonly #cancellation = new AbortController();
  readonly #completion = Promise.withResolvers<NodeHistoryCursorSettlement>();
  readonly #iterator: AsyncIterator<readonly AgentImportedTranscriptRow[]>;
  readonly #detach: () => void;
  readonly #idleTimeoutMs: number;
  #phase: 'idle' | 'advancing' | 'offered' | 'transferring' | 'eof' | 'closing' | 'closed' = 'idle';
  #sequence = 1;
  #rows: readonly AgentImportedTranscriptRow[] = [];
  #rowIndex = 0;
  #offer: Extract<NodeHistoryCursorNext, { kind: 'row' }> | null = null;
  #encoded: EncodedNodeHistoryRow | null = null;
  #sourceDone = false;
  #active = false;
  #cleanup: Promise<void> | null = null;
  #failure: { error: unknown } | null = null;
  #idle: { readonly deadline: NodeDeadline; readonly timer: { cancel(): void } } | null = null;

  constructor(private readonly options: NodeHistoryCursorOptions) {
    this.#idleTimeoutMs = options.idleTimeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.#idleTimeoutMs) || this.#idleTimeoutMs < 1) throw new TypeError('Invalid history idle timeout');
    try {
      options.signal.throwIfAborted();
      this.#iterator = options.source.read(options.request, this.#cancellation.signal)[Symbol.asyncIterator]();
    } catch (error) { options.release(); throw error; }
    const cancel = () => this.cancel(options.signal.reason);
    this.#detach = () => options.signal.removeEventListener('abort', cancel);
    options.signal.addEventListener('abort', cancel, { once: true });
    if (options.signal.aborted) cancel();
    else this.#armIdle();
  }

  get settled(): Promise<NodeHistoryCursorSettlement> { return this.#completion.promise; }

  next(sequence: number, signal: AbortSignal, deadline: NodeDeadline): Promise<NodeHistoryCursorNext> {
    this.#require('idle', sequence);
    this.#phase = 'advancing';
    return this.#run(signal, deadline, async () => {
      if (this.#rowIndex === this.#rows.length) {
        this.#rows = []; this.#rowIndex = 0;
        const next = await this.#iterator.next();
        this.#sourceDone = next.done === true;
        this.#cancellation.signal.throwIfAborted();
        if (this.#sourceDone) {
          this.#phase = 'eof';
          return { kind: 'eof', sequence };
        }
        if (!Array.isArray(next.value) || !next.value.length || next.value.length > PROVIDER_HISTORY_IMPORT_MAX_BATCH_ROWS) throw invalid();
        this.#rows = next.value;
      }
      this.#encoded = encodeNodeHistoryRow(this.#rows[this.#rowIndex++]!, this.options.memory);
      const bytes = this.#encoded.bytes;
      this.#offer = Object.freeze({ kind: 'row', sequence, encoding: NODE_HISTORY_ROW_ENCODING,
        descriptor: Object.freeze({ byteLength: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') }) });
      this.#phase = 'offered';
      return this.#offer;
    });
  }

  transfer(sequence: number, grant: NodeBulkIdentity, descriptor: NodeBulkDescriptor, signal: AbortSignal, deadline: NodeDeadline): Promise<void> {
    this.#require('offered', sequence);
    const offer = this.#offer!;
    if (descriptor.byteLength !== offer.descriptor.byteLength || descriptor.sha256 !== offer.descriptor.sha256) {
      const error = invalid(); this.cancel(error); throw error;
    }
    this.#phase = 'transferring';
    return this.#run(signal, deadline, async () => {
      await this.options.transfer(this.#encoded!.bytes, sequence, grant, offer.descriptor, this.#cancellation.signal, deadline);
      this.#cancellation.signal.throwIfAborted();
      this.#encoded!.release(); this.#encoded = null; this.#offer = null;
      if (!Number.isSafeInteger(++this.#sequence)) throw invalid();
      this.#phase = 'idle';
    });
  }

  cancel(reason: unknown = unavailable()): void {
    if (this.#phase === 'closed') return;
    this.#phase = 'closing';
    this.#clearIdle();
    this.#cancellation.abort(reason);
    if (!this.#active) void this.#closeIterator();
  }

  #require(phase: 'idle' | 'offered', sequence: number): void {
    if (this.#idle?.deadline.remainingMs === 0) this.cancel(unavailable());
    this.#cancellation.signal.throwIfAborted();
    if (this.#phase !== phase || this.#active || sequence !== this.#sequence) {
      const error = invalid(); this.cancel(error); throw error;
    }
  }

  #run<T>(signal: AbortSignal, deadline: NodeDeadline, execute: () => Promise<T>): Promise<T> {
    this.#clearIdle(); this.#active = true;
    const cancel = () => this.cancel(signal.reason);
    signal.addEventListener('abort', cancel, { once: true });
    const timer = this.#schedule(() => this.cancel(unavailable()), deadline.remainingMs);
    if (signal.aborted) cancel();
    if (deadline.remainingMs === 0) this.cancel(unavailable());
    const operation = Promise.resolve().then(async () => {
      let result: T;
      try {
        this.#cancellation.signal.throwIfAborted();
        result = await execute();
        if (deadline.remainingMs === 0) this.cancel(unavailable());
        this.#cancellation.signal.throwIfAborted();
      } catch (error) {
        this.#failure = { error }; this.#phase = 'closing';
      }
      this.#active = false;
      if (this.#phase === 'closing' || this.#phase === 'eof') await this.#closeIterator();
      else this.#armIdle();
      if (this.#failure) throw this.#failure.error;
      return result!;
    }).finally(() => { timer.cancel(); signal.removeEventListener('abort', cancel); });
    return waitForCursor(operation, this.#cancellation.signal);
  }

  #closeIterator(): Promise<void> {
    return this.#cleanup ??= Promise.resolve().then(async () => {
      try { if (!this.#sourceDone) await this.#iterator.return?.(); }
      catch (error) {
        this.#failure = { error: this.#failure ? new AggregateError([this.#failure.error, error], 'History import and cleanup failed') : error };
      } finally {
        const kind = this.#cancellation.signal.aborted ? 'cancelled' : this.#failure ? 'failed' : 'complete';
        this.#phase = 'closed'; this.#clearIdle(); this.#detach();
        this.#rows = []; this.#offer = null; this.#encoded?.release(); this.#encoded = null;
        this.options.release();
        this.#completion.resolve({ kind, ...(this.#failure ?? (kind === 'cancelled' ? { error: this.#cancellation.signal.reason } : {})) });
      }
    });
  }

  #armIdle(): void {
    this.#clearIdle();
    const deadline = new NodeDeadline(this.#idleTimeoutMs, this.options.createClock?.());
    this.#idle = { deadline, timer: this.#schedule(() => this.cancel(unavailable()), deadline.remainingMs) };
  }

  #clearIdle(): void { this.#idle?.timer.cancel(); this.#idle = null; }
  #schedule(callback: () => void, delay: number): { cancel(): void } {
    if (this.options.scheduleTimeout) return this.options.scheduleTimeout(callback, delay);
    const timer = setTimeout(callback, delay); timer.unref();
    return { cancel: () => clearTimeout(timer) };
  }
}

function waitForCursor<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cancel = () => reject(signal.reason);
    signal.addEventListener('abort', cancel, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
    if (signal.aborted) cancel();
  });
}

export class NodeHistoryCursorError extends Error {
  constructor(readonly code: 'NODE_HISTORY_INVALID' | 'NODE_HISTORY_UNAVAILABLE', message: string) {
    super(message); this.name = 'NodeHistoryCursorError';
  }
}

function invalid(): NodeHistoryCursorError { return new NodeHistoryCursorError('NODE_HISTORY_INVALID', 'Invalid history cursor transition'); }
function unavailable(): NodeHistoryCursorError { return new NodeHistoryCursorError('NODE_HISTORY_UNAVAILABLE', 'History import is unavailable or expired'); }
