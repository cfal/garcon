import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  ChatSearchIndexStatus,
  ChatSearchQueryV1,
  ChatSearchResult,
  TranscriptSearchAllowedChat,
  TranscriptSearchQueryStatsV1,
  TranscriptSearchStatusV1,
} from '@garcon/common/chat-search';
import type { JsonObject } from '@garcon/common/json';
import type { AgentLogger } from '@garcon/server-agent-interface';
import { resolveSearchWorkerEntrypoints } from '../build/standalone-entrypoint.js';
import type { HistoricalSearchMessageRow } from './rows.js';
import { SEARCH_INGEST_ROW_MAX_BYTES, type SearchChatState } from './schema.js';
import type {
  IndexerEvent,
  IndexerRequest,
  ReaderEvent,
  ReaderRequest,
} from './worker-protocol.js';
import {
  MAX_ALLOWLIST_PER_FRAME,
  MAX_FRAME_BYTES,
  MAX_ROWS_PER_FRAME,
  isIndexerEvent,
  isReaderEvent,
} from './worker-protocol.js';
import {
  SearchWorkerSupervisor,
  type WorkerRequestInput,
} from './worker-supervisor.js';

const SEARCH_DIRECTORY = 'transcript-search';
const REQUEST_TIMEOUT_MS = 30_000;
const FRAME_TIMEOUT_MS = 30_000;
const SEARCH_READER_REQUEST_TIMEOUT_MS = 30_000;
const WORKER_CLOSE_TIMEOUT_MS = 5_000;
const SEARCH_READER_POOL_SIZE = 2;
const SEARCH_MAX_QUEUED = 4;
const SEARCH_MAINTENANCE_PASSES = 4;
const STATUS_COALESCE_MS = 250;
const QUERY_STATS_SAMPLE = 512;

export interface TranscriptSearchServiceOptions {
  readonly workspaceDirectory: string;
  readonly logger: AgentLogger;
  readonly workerFactory?: (role: 'indexer' | 'reader', moduleUrl: string) => Worker;
  readonly readerRequestTimeoutMs?: number;
}

export interface TranscriptSearchSyncFrame {
  readonly rows: readonly HistoricalSearchMessageRow[];
  readonly advanceTo: number;
}

export interface TranscriptSearchSyncRequest {
  readonly mode: 'replace' | 'append';
  readonly chatId: string;
  readonly transcriptViewId: string;
  readonly expectedAfterOrdinal: number;
  readonly targetThrough: number;
  readonly source: (
    afterOrdinal: number,
  ) => AsyncGenerator<TranscriptSearchSyncFrame, void, void>;
}

export type TranscriptSearchQueryStats = TranscriptSearchQueryStatsV1;

export interface TranscriptSearchResyncScope {
  chatSettled(): void;
  complete(): void;
  fail(errorCode: string): void;
}

const DISABLED_STATUS: TranscriptSearchStatusV1 = {
  version: 1,
  phase: 'disabled',
  chats: { indexed: 0, pending: 0, failed: 0 },
  queuedJobs: 0,
  resync: null,
  backlogRows: 0,
  activeChat: null,
  lastErrorCode: null,
  updatedAt: new Date(0).toISOString(),
};

export class TranscriptSearchWorkerError extends Error {
  constructor(readonly code: string, readonly retryable: boolean) {
    super(code);
    this.name = 'TranscriptSearchWorkerError';
  }
}

type IngestJob =
  | {
      readonly kind: 'sync';
      readonly chatId: string;
      readonly request: TranscriptSearchSyncRequest;
      resolve(): void;
      reject(error: Error): void;
    }
  | {
      readonly kind: 'delete';
      readonly chatId: string;
      resolve(): void;
      reject(error: Error): void;
    }
  | {
      readonly kind: 'fail';
      readonly chatId: string;
      readonly transcriptViewId: string;
      readonly errorCode: string;
      resolve(): void;
      reject(error: Error): void;
    };

interface ReaderSlot {
  readonly supervisor: SearchWorkerSupervisor<ReaderRequest, ReaderEvent>;
  state: 'idle' | 'busy' | 'quarantined';
}

interface SearchWaiter {
  resolve(slot: ReaderSlot): void;
  reject(error: Error): void;
}

export class TranscriptSearchService {
  readonly #searchDirectory: string;
  readonly #dbPath: string;
  readonly #logger: AgentLogger;
  readonly #readerRequestTimeoutMs: number;
  readonly #indexer: SearchWorkerSupervisor<IndexerRequest, IndexerEvent>;
  readonly #readers: ReaderSlot[] = [];
  readonly #deleteQueue: IngestJob[] = [];
  readonly #buildQueue: IngestJob[] = [];
  readonly #jobChatIds = new Set<string>();
  readonly #searchWaiters: SearchWaiter[] = [];
  readonly #statusListeners = new Set<(status: TranscriptSearchStatusV1) => void>();
  readonly #queryDurations: number[] = [];
  readonly #lastLogAt = new Map<string, number>();
  #queryCounters = { served: 0, timedOut: 0, rejectedBusy: 0 };
  #durableCounts = { indexed: 0, pending: 0, failed: 0 };
  #durableBacklogRows = 0;
  #activeJob: IngestJob | null = null;
  #activeProgress: { position: number; total: number } | null = null;
  #ingestPumpActive = false;
  #phaseOverride: 'opening' | 'failed' | null = null;
  #lastErrorCode: string | null = null;
  #indexRecreated = false;
  #resync: { completed: number; total: number } | null = null;
  #catalogCurrent = false;
  #countsDirty = false;
  #countsRetryTimer: ReturnType<typeof setTimeout> | null = null;
  #countsRetryArmed = false;
  #statusDirty = false;
  #statusWorkerActive = false;
  #lastStatusContent = '';
  #lastStatus: TranscriptSearchStatusV1 = DISABLED_STATUS;
  #emitTimer: ReturnType<typeof setTimeout> | null = null;
  #emitPending = false;
  #enabled = false;
  #closed = false;
  #resyncHandler: (() => void | Promise<void>) | null = null;

  constructor(options: TranscriptSearchServiceOptions) {
    this.#searchDirectory = path.join(options.workspaceDirectory, SEARCH_DIRECTORY);
    this.#dbPath = path.join(this.#searchDirectory, 'index.sqlite');
    this.#logger = options.logger;
    this.#readerRequestTimeoutMs =
      options.readerRequestTimeoutMs ?? SEARCH_READER_REQUEST_TIMEOUT_MS;
    const entrypoints = resolveSearchWorkerEntrypoints({
      indexerSourceUrl: new URL('./indexer-main.ts', import.meta.url),
      readerSourceUrl: new URL('./reader-main.ts', import.meta.url),
    });
    this.#indexer = new SearchWorkerSupervisor({
      role: 'indexer',
      moduleUrl: entrypoints.indexer,
      logger: options.logger,
      workerFactory: options.workerFactory,
      createRequest: (input, envelope) => ({ ...input, ...envelope }),
      isEvent: isIndexerEvent,
      eventError: workerEventError,
      isProgress: (event) => event.type === 'delete-progress',
      shouldRestart: () => this.#enabled && !this.#closed,
      admit: async (signal) => {
        const event = await this.#indexer.request(
          [{ type: 'open', dbPath: this.#dbPath }],
          signal,
          REQUEST_TIMEOUT_MS,
        );
        if (event.type !== 'opened') throw new Error('Transcript indexer admission failed');
        this.#indexRecreated = event.recreated;
      },
      afterRestart: async () => {
        this.#logRestart('SEARCH_INDEXER_RESTARTED');
        await this.#resyncHandler?.();
      },
      onAdmitted: () => {
        this.#clearCountsRetry();
        if (this.#countsDirty) void this.#statusWorker();
      },
      onEvent: () => {},
      onCrash: () => this.#noteStatusMaybeChanged(),
    });
    for (let index = 0; index < SEARCH_READER_POOL_SIZE; index += 1) {
      this.#readers.push(this.#createReaderSlot(options, entrypoints.reader));
    }
  }

  #createReaderSlot(options: TranscriptSearchServiceOptions, moduleUrl: string): ReaderSlot {
    let slot: ReaderSlot;
    const supervisor: SearchWorkerSupervisor<ReaderRequest, ReaderEvent> =
      new SearchWorkerSupervisor({
        role: 'reader',
        moduleUrl,
        logger: options.logger,
        workerFactory: options.workerFactory,
        createRequest: (input, envelope) => ({ ...input, ...envelope }),
        isEvent: isReaderEvent,
        eventError: workerEventError,
        shouldRestart: () => this.#enabled && !this.#closed,
        admit: async (signal) => {
          const event = await supervisor.request(
            [{ type: 'open', dbPath: this.#dbPath }],
            signal,
            REQUEST_TIMEOUT_MS,
          );
          if (event.type !== 'opened') throw new Error('Transcript reader admission failed');
        },
        afterRestart: async () => this.#logRestart('SEARCH_READER_RESTARTED'),
        onAdmitted: () => this.#onReaderAdmitted(slot),
        onEvent: () => {},
        onCrash: () => this.#noteStatusMaybeChanged(),
      });
    slot = { supervisor, state: 'idle' };
    return slot;
  }

  setResyncHandler(handler: () => void | Promise<void>): void {
    this.#resyncHandler = handler;
  }

  async enable(signal: AbortSignal): Promise<void> {
    if (this.#closed) throw new Error('Transcript search service is closed');
    if (this.#enabled) return;
    signal.throwIfAborted();
    const startedAt = performance.now();
    await fs.mkdir(this.#searchDirectory, { recursive: true, mode: 0o700 });
    this.#phaseOverride = 'opening';
    this.#noteStatusMaybeChanged();
    try {
      await this.#indexer.start(signal);
      for (const slot of this.#readers) await slot.supervisor.start(signal);
      this.#enabled = true;
      this.#phaseOverride = null;
      this.#lastErrorCode = null;
      this.#noteDurableProgress();
      this.#logger.info('Transcript search enabled', {
        code: 'SEARCH_ENABLED',
        openMs: Math.round(performance.now() - startedAt),
        recreated: this.#indexRecreated,
      });
    } catch (error) {
      this.#phaseOverride = 'failed';
      this.#lastErrorCode = 'SEARCH_INDEX_ADMISSION_FAILED';
      await this.#stopWorkers();
      throw error;
    } finally {
      this.#noteStatusMaybeChanged();
    }
  }

  async chatStates(): Promise<readonly SearchChatState[]> {
    const event = await this.#requestIndexer({ type: 'chat-states' });
    if (event.type !== 'chat-states-result') throw new Error('SEARCH_INDEX_INVALID_RESPONSE');
    return event.states;
  }

  syncChat(request: TranscriptSearchSyncRequest): Promise<void> {
    return this.#enqueueIngest(
      request.chatId,
      (resolve, reject) => ({
        kind: 'sync',
        chatId: request.chatId,
        request,
        resolve,
        reject,
      }),
      this.#buildQueue,
    );
  }

  deleteChat(chatId: string): Promise<void> {
    return this.#enqueueIngest(
      chatId,
      (resolve, reject) => ({ kind: 'delete', chatId, resolve, reject }),
      this.#deleteQueue,
    );
  }

  markChatUnavailable(
    chatId: string,
    transcriptViewId: string,
    errorCode: string,
  ): Promise<void> {
    return this.#enqueueIngest(
      chatId,
      (resolve, reject) => ({
        kind: 'fail',
        chatId,
        transcriptViewId,
        errorCode,
        resolve,
        reject,
      }),
      this.#deleteQueue,
    );
  }

  beginResync(totalChats: number): TranscriptSearchResyncScope {
    if (!Number.isSafeInteger(totalChats) || totalChats < 0) {
      throw new Error('SEARCH_RESYNC_INVARIANT');
    }
    const scope = { completed: 0, total: totalChats };
    this.#resync = scope;
    this.#noteStatusMaybeChanged();
    return {
      chatSettled: () => {
        if (this.#resync !== scope) return;
        if (scope.completed >= scope.total) throw new Error('SEARCH_RESYNC_INVARIANT');
        scope.completed += 1;
        this.#noteStatusMaybeChanged();
      },
      complete: () => {
        if (this.#resync !== scope) return;
        if (scope.completed !== scope.total) throw new Error('SEARCH_RESYNC_INVARIANT');
        this.#resync = null;
        this.#catalogCurrent = true;
        this.#lastErrorCode = null;
        this.#noteDurableProgress();
      },
      fail: (errorCode) => {
        if (this.#resync !== scope) return;
        this.#resync = null;
        this.#recordCatalogFailure(errorCode);
      },
    };
  }

  recordResyncFailure(errorCode: string): void {
    this.#recordCatalogFailure(errorCode);
  }

  #recordCatalogFailure(errorCode: string): void {
    const code = /^[A-Z][A-Z0-9_]{0,63}$/.test(errorCode)
      ? errorCode
      : 'SEARCH_RESYNC_FAILED';
    this.#catalogCurrent = false;
    this.#lastErrorCode = code;
    this.#noteStatusMaybeChanged();
  }

  status(): TranscriptSearchStatusV1 {
    return this.#lastStatus;
  }

  queryStats(): TranscriptSearchQueryStats {
    const sorted = [...this.#queryDurations].sort((left, right) => left - right);
    const at = (quantile: number) => sorted.length === 0
      ? 0
      : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))]!;
    return {
      ...this.#queryCounters,
      p50Ms: at(0.5),
      p95Ms: at(0.95),
      maxMs: sorted.at(-1) ?? 0,
    };
  }

  onStatusChanged(listener: (status: TranscriptSearchStatusV1) => void): () => void {
    this.#statusListeners.add(listener);
    return () => this.#statusListeners.delete(listener);
  }

  async search(request: {
    readonly query: ChatSearchQueryV1;
    readonly allowedChats: readonly TranscriptSearchAllowedChat[];
    readonly limit: number;
    readonly signal: AbortSignal;
  }): Promise<{
    readonly results: readonly ChatSearchResult[];
    readonly index: ChatSearchIndexStatus;
  }> {
    if (!this.#enabled || this.#closed) throw new Error('SEARCH_INDEX_UNAVAILABLE');
    request.signal.throwIfAborted();
    const slot = await this.#acquireReaderSlot(request.signal);
    const started = performance.now();
    const session = slot.supervisor.beginRequestSession();
    const frames = searchFrames(request.query, request.allowedChats, request.limit);
    const pending = session.request(frames, undefined, this.#readerRequestTimeoutMs, {
      isComplete: (candidate) => candidate.type === 'search-result',
    });
    void pending.then(
      () => this.#settleReaderSlot(slot),
      () => this.#settleReaderSlot(slot),
    );
    let event: ReaderEvent;
    try {
      event = await raceAgainstSignal(pending, request.signal);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        this.#queryCounters.timedOut += 1;
        this.#rateLimitedWarn('Transcript search query timeout', {
          code: 'SEARCH_TIMEOUT',
          executeMs: Math.round(performance.now() - started),
        });
        throw new Error('SEARCH_TIMEOUT');
      }
      throw error;
    }
    if (event.type !== 'search-result') throw new Error('SEARCH_INDEX_INVALID_RESPONSE');
    const allowed = new Map(
      request.allowedChats.map((entry) => [entry.chatId, entry.transcriptViewId]),
    );
    if (event.results.some((result) => allowed.get(result.chatId) !== result.transcriptViewId)) {
      throw new Error('SEARCH_INDEX_INVALID_RESPONSE');
    }
    this.#queryCounters.served += 1;
    this.#recordQueryDuration(performance.now() - started);
    return { results: event.results, index: event.index };
  }

  async disableAndDelete(signal: AbortSignal): Promise<void> {
    this.#enabled = false;
    this.#rejectQueues(new Error('SEARCH_INDEX_UNAVAILABLE'));
    await this.#stopWorkers();
    signal.throwIfAborted();
    await fs.rm(this.#searchDirectory, { recursive: true, force: true });
    this.#durableCounts = { indexed: 0, pending: 0, failed: 0 };
    this.#durableBacklogRows = 0;
    this.#resync = null;
    this.#catalogCurrent = false;
    this.#activeProgress = null;
    this.#lastErrorCode = null;
    this.#countsDirty = false;
    this.#clearCountsRetry();
    this.#noteStatusMaybeChanged();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#enabled = false;
    this.#rejectQueues(new Error('SEARCH_INDEX_UNAVAILABLE'));
    if (this.#emitTimer) clearTimeout(this.#emitTimer);
    this.#clearCountsRetry();
    await this.#stopWorkers();
  }

  #clearCountsRetry(): void {
    this.#countsRetryArmed = false;
    if (this.#countsRetryTimer) {
      clearTimeout(this.#countsRetryTimer);
      this.#countsRetryTimer = null;
    }
  }

  #acquireReaderSlot(signal: AbortSignal): Promise<ReaderSlot> {
    const idle = this.#readers.find(
      (slot) => slot.state === 'idle' && slot.supervisor.available,
    );
    if (idle) {
      idle.state = 'busy';
      return Promise.resolve(idle);
    }
    if (!this.#readers.some((slot) => slot.supervisor.available)) {
      return Promise.reject(new Error('SEARCH_INDEX_UNAVAILABLE'));
    }
    if (this.#searchWaiters.length >= SEARCH_MAX_QUEUED) {
      this.#queryCounters.rejectedBusy += 1;
      this.#rateLimitedWarn('Transcript search queue overflow', {
        code: 'SEARCH_INDEX_BUSY',
        depth: this.#searchWaiters.length,
      });
      return Promise.reject(new Error('SEARCH_INDEX_BUSY'));
    }
    return new Promise<ReaderSlot>((resolve, reject) => {
      const waiter: SearchWaiter = { resolve, reject };
      this.#searchWaiters.push(waiter);
      signal.addEventListener('abort', () => {
        const index = this.#searchWaiters.indexOf(waiter);
        if (index >= 0) {
          this.#searchWaiters.splice(index, 1);
          this.#queryCounters.timedOut += 1;
          reject(new Error('SEARCH_TIMEOUT'));
        }
      }, { once: true });
    });
  }

  #settleReaderSlot(slot: ReaderSlot): void {
    if (slot.supervisor.available) {
      this.#dispatchOrIdle(slot);
    } else {
      slot.state = 'quarantined';
      this.#noteStatusMaybeChanged();
    }
  }

  #onReaderAdmitted(slot: ReaderSlot): void {
    if (slot.state === 'quarantined') slot.state = 'idle';
    this.#dispatchWaiters();
    this.#noteStatusMaybeChanged();
  }

  #dispatchOrIdle(slot: ReaderSlot): void {
    const waiter = this.#searchWaiters.shift();
    if (waiter && slot.supervisor.available) {
      waiter.resolve(slot);
      return;
    }
    slot.state = 'idle';
    if (waiter) this.#requeueOrFail(waiter);
  }

  #dispatchWaiters(): void {
    while (this.#searchWaiters.length > 0) {
      const idle = this.#readers.find(
        (slot) => slot.state === 'idle' && slot.supervisor.available,
      );
      if (!idle) return;
      idle.state = 'busy';
      this.#searchWaiters.shift()!.resolve(idle);
    }
  }

  #requeueOrFail(waiter: SearchWaiter): void {
    const idle = this.#readers.find(
      (slot) => slot.state === 'idle' && slot.supervisor.available,
    );
    if (idle) {
      idle.state = 'busy';
      waiter.resolve(idle);
    } else if (this.#readers.some((slot) => slot.supervisor.available)) {
      this.#searchWaiters.unshift(waiter);
    } else {
      waiter.reject(new Error('SEARCH_INDEX_UNAVAILABLE'));
    }
  }

  #enqueueIngest(
    chatId: string,
    build: (resolve: () => void, reject: (error: Error) => void) => IngestJob,
    queue: IngestJob[],
  ): Promise<void> {
    if (!this.#enabled || this.#closed) return Promise.resolve();
    if (this.#jobChatIds.has(chatId)) {
      return Promise.reject(new Error('SEARCH_JOB_CONFLICT'));
    }
    this.#jobChatIds.add(chatId);
    return new Promise<void>((resolve, reject) => {
      queue.push(build(resolve, reject));
      this.#noteStatusMaybeChanged();
      void this.#pumpIngest();
    });
  }

  async #pumpIngest(): Promise<void> {
    if (this.#ingestPumpActive) return;
    this.#ingestPumpActive = true;
    try {
      while (this.#enabled && !this.#closed) {
        const job = this.#deleteQueue.shift() ?? this.#buildQueue.shift() ?? null;
        if (!job) break;
        this.#activeJob = job;
        this.#noteStatusMaybeChanged();
        try {
          if (job.kind === 'delete') await this.#runDelete(job.chatId);
          else if (job.kind === 'fail') await this.#runMarkFailed(job);
          else await this.#runSync(job.request);
          job.resolve();
        } catch (error) {
          job.reject(asError(error));
        } finally {
          this.#jobChatIds.delete(job.chatId);
          this.#activeJob = null;
          this.#activeProgress = null;
          this.#noteDurableProgress();
        }
      }
    } finally {
      this.#ingestPumpActive = false;
    }
  }

  async #runSync(request: TranscriptSearchSyncRequest): Promise<void> {
    const session = this.#indexer.beginRequestSession();
    const accepted = await session.request([{
      type: 'sync-begin',
      mode: request.mode,
      chatId: request.chatId,
      transcriptViewId: request.transcriptViewId,
      expectedAfterOrdinal: request.expectedAfterOrdinal,
      targetThrough: request.targetThrough,
    }], undefined, FRAME_TIMEOUT_MS, {
      isComplete: (event) => event.type === 'sync-accepted',
    });
    if (accepted.type !== 'sync-accepted') throw new Error('SEARCH_INDEX_INVALID_RESPONSE');
    this.#noteDurableProgress();
    if (accepted.current) return;
    this.#activeProgress = {
      position: accepted.indexedThrough,
      total: request.targetThrough,
    };
    try {
      let staleRows = accepted.staleRows;
      while (staleRows) {
        const cleanup = await session.request(
          [{ type: 'sync-cleanup' }],
          undefined,
          FRAME_TIMEOUT_MS,
          { isComplete: (event) => event.type === 'cleanup-progress' },
        );
        if (cleanup.type !== 'cleanup-progress') {
          throw new Error('SEARCH_INDEX_INVALID_RESPONSE');
        }
        staleRows = cleanup.remaining;
        this.#noteDurableProgress();
      }
      let frameIndex = 0;
      let indexedThrough = accepted.indexedThrough;
      for await (const frame of request.source(accepted.indexedThrough)) {
        for (const chunk of chunkFrame(frame)) {
          const currentFrame = frameIndex;
          const event = await session.request([{
            type: 'sync-rows',
            frameIndex: currentFrame,
            rows: chunk.rows,
            advanceTo: chunk.advanceTo,
          }], undefined, FRAME_TIMEOUT_MS, {
            isComplete: (candidate) => candidate.type === 'sync-progress'
              && candidate.frameIndex === currentFrame,
          });
          if (event.type !== 'sync-progress') {
            throw new Error('SEARCH_INDEX_INVALID_RESPONSE');
          }
          frameIndex += 1;
          indexedThrough = event.indexedThrough;
          this.#activeProgress = { position: indexedThrough, total: request.targetThrough };
          this.#noteDurableProgress();
        }
      }
      if (indexedThrough !== request.targetThrough) throw new Error('SEARCH_INDEX_GAP');
      const complete = await session.request(
        [{ type: 'sync-finish' }],
        undefined,
        FRAME_TIMEOUT_MS,
        { isComplete: (candidate) => candidate.type === 'sync-complete' },
      );
      if (complete.type !== 'sync-complete') throw new Error('SEARCH_INDEX_INVALID_RESPONSE');
    } catch (error) {
      const code = indexFailureCode(error);
      if (!isRepairableIndexPositionError(error)) {
        await this.#requestIndexer({
          type: 'mark-failed',
          chatId: request.chatId,
          transcriptViewId: request.transcriptViewId,
          errorCode: code,
        }).catch(() => undefined);
      }
      throw error;
    }
  }

  async #runDelete(chatId: string): Promise<void> {
    const event = await this.#requestIndexer({ type: 'delete-chat', chatId });
    if (event.type !== 'ack') throw new Error('SEARCH_INDEX_INVALID_RESPONSE');
    this.#noteDurableProgress();
    const checkpoint = await this.#requestIndexer({ type: 'checkpoint' }).catch(() => null);
    if (!checkpoint || checkpoint.type !== 'checkpoint-complete' || checkpoint.busy !== 0) {
      this.#rateLimitedWarn('Transcript search checkpoint deferred.', {
        code: 'SEARCH_WAL_TRUNCATE_DEFERRED',
      });
    }
    for (let pass = 0; pass < SEARCH_MAINTENANCE_PASSES; pass += 1) {
      const maintained = await this.#requestIndexer({ type: 'maintenance' }).catch(() => null);
      if (!maintained || maintained.type !== 'ack') break;
    }
  }

  async #runMarkFailed(job: Extract<IngestJob, { kind: 'fail' }>): Promise<void> {
    const event = await this.#requestIndexer({
      type: 'mark-failed',
      chatId: job.chatId,
      transcriptViewId: job.transcriptViewId,
      errorCode: job.errorCode,
    });
    if (event.type !== 'ack') throw new Error('SEARCH_INDEX_INVALID_RESPONSE');
  }

  #noteDurableProgress(): void {
    this.#countsDirty = true;
    this.#noteStatusMaybeChanged();
  }

  #noteStatusMaybeChanged(): void {
    this.#statusDirty = true;
    void this.#statusWorker();
  }

  async #statusWorker(): Promise<void> {
    if (this.#statusWorkerActive) return;
    this.#statusWorkerActive = true;
    try {
      while (this.#statusDirty || this.#countsDirty) {
        if (this.#countsDirty) {
          if (!this.#enabled || this.#closed) {
            this.#countsDirty = false;
          } else {
            const event = await this.#requestIndexer({ type: 'status-snapshot' })
              .catch(() => null);
            if (!event || event.type !== 'status-result') {
              this.#scheduleCountsRetry();
              return;
            }
            this.#countsDirty = false;
            this.#countsRetryArmed = false;
            this.#durableCounts = {
              indexed: event.counts.indexed,
              pending: event.counts.pending,
              failed: event.counts.failed,
            };
            this.#durableBacklogRows = event.counts.backlogRows;
          }
        }
        this.#statusDirty = false;
        this.#publishIfChanged();
      }
    } finally {
      this.#statusWorkerActive = false;
    }
  }

  #scheduleCountsRetry(): void {
    if (this.#countsRetryArmed || this.#countsRetryTimer) return;
    this.#countsRetryArmed = true;
    this.#countsRetryTimer = setTimeout(() => {
      this.#countsRetryTimer = null;
      void this.#statusWorker();
    }, 1_000);
    this.#countsRetryTimer.unref?.();
  }

  #publishIfChanged(): void {
    const content = {
      version: 1 as const,
      phase: this.#phase(),
      chats: { ...this.#durableCounts },
      queuedJobs: this.#queuedJobCount(),
      resync: this.#resync
        ? { completedChats: this.#resync.completed, totalChats: this.#resync.total }
        : null,
      backlogRows: this.#durableBacklogRows,
      activeChat: this.#activeProgress ? { ...this.#activeProgress } : null,
      lastErrorCode: this.#lastErrorCode,
    };
    const serialized = JSON.stringify(content);
    if (serialized === this.#lastStatusContent) return;
    const phaseChanged = this.#lastStatus.phase !== content.phase;
    this.#lastStatusContent = serialized;
    this.#lastStatus = { ...content, updatedAt: new Date().toISOString() };
    this.#scheduleEmit(phaseChanged);
  }

  #scheduleEmit(immediate: boolean): void {
    this.#emitPending = true;
    if (immediate) {
      if (this.#emitTimer) {
        clearTimeout(this.#emitTimer);
        this.#emitTimer = null;
      }
      this.#emitNow();
      return;
    }
    if (this.#emitTimer) return;
    this.#emitTimer = setTimeout(() => {
      this.#emitTimer = null;
      this.#emitNow();
    }, STATUS_COALESCE_MS);
    this.#emitTimer.unref?.();
  }

  #emitNow(): void {
    if (!this.#emitPending) return;
    this.#emitPending = false;
    const snapshot = this.#lastStatus;
    if (snapshot.phase === 'rebuilding') {
      this.#rateLimitedInfo('Transcript search ingest progress', {
        code: 'SEARCH_INGEST_PROGRESS',
        chatsIndexed: snapshot.chats.indexed,
        resyncCompleted: snapshot.resync?.completedChats ?? null,
        resyncTotal: snapshot.resync?.totalChats ?? null,
        backlogRows: snapshot.backlogRows,
      });
    }
    for (const listener of this.#statusListeners) listener(snapshot);
  }

  #queuedJobCount(): number {
    return this.#deleteQueue.length + this.#buildQueue.length + (this.#activeJob ? 1 : 0);
  }

  #phase(): TranscriptSearchStatusV1['phase'] {
    if (this.#closed || (!this.#enabled && this.#phaseOverride === null)) return 'disabled';
    if (this.#phaseOverride) return this.#phaseOverride;
    const readersDown = this.#readers.some((slot) => !slot.supervisor.available);
    if (!this.#indexer.available || readersDown) return 'degraded';
    if (this.#resync !== null || this.#queuedJobCount() > 0) return 'rebuilding';
    if (
      !this.#catalogCurrent
      || this.#durableCounts.failed > 0
      || this.#durableCounts.pending > 0
    ) return 'degraded';
    return 'ready';
  }

  #recordQueryDuration(durationMs: number): void {
    this.#queryDurations.push(Math.round(durationMs));
    if (this.#queryDurations.length > QUERY_STATS_SAMPLE) this.#queryDurations.shift();
  }

  #rejectQueues(error: Error): void {
    for (const job of [...this.#deleteQueue.splice(0), ...this.#buildQueue.splice(0)]) {
      this.#jobChatIds.delete(job.chatId);
      job.reject(error);
    }
    for (const waiter of this.#searchWaiters.splice(0)) waiter.reject(error);
  }

  #requestIndexer(input: WorkerRequestInput<IndexerRequest>): Promise<IndexerEvent> {
    return this.#indexer.request([input], undefined, REQUEST_TIMEOUT_MS);
  }

  #logRestart(code: 'SEARCH_INDEXER_RESTARTED' | 'SEARCH_READER_RESTARTED'): void {
    this.#logger.warn('Transcript search worker restarted.', { code });
    this.#noteStatusMaybeChanged();
  }

  #rateLimitedWarn(message: string, fields: JsonObject & { readonly code: string }): void {
    if (!this.#shouldLog(fields.code)) return;
    this.#logger.warn(message, fields);
  }

  #rateLimitedInfo(message: string, fields: JsonObject & { readonly code: string }): void {
    if (!this.#shouldLog(fields.code)) return;
    this.#logger.info(message, fields);
  }

  #shouldLog(code: string): boolean {
    const now = performance.now();
    const last = this.#lastLogAt.get(code) ?? Number.NEGATIVE_INFINITY;
    if (now - last < 10_000) return false;
    this.#lastLogAt.set(code, now);
    return true;
  }

  async #stopWorkers(): Promise<void> {
    await Promise.all([
      ...this.#readers.map(
        (slot) => slot.supervisor.stop({ type: 'close' }, WORKER_CLOSE_TIMEOUT_MS),
      ),
      this.#indexer.stop({ type: 'close' }, WORKER_CLOSE_TIMEOUT_MS),
    ]);
  }
}

function raceAgainstSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function chunkFrame(frame: TranscriptSearchSyncFrame): Array<{
  rows: readonly HistoricalSearchMessageRow[];
  advanceTo: number;
}> {
  const chunks: HistoricalSearchMessageRow[][] = [];
  let current: HistoricalSearchMessageRow[] = [];
  let bytes = 2;
  for (const row of frame.rows) {
    if (Buffer.byteLength(row.body, 'utf8') > SEARCH_INGEST_ROW_MAX_BYTES) {
      throw new Error('SEARCH_ROW_TOO_LARGE');
    }
    const rowBytes = Buffer.byteLength(JSON.stringify(row)) + (current.length > 0 ? 1 : 0);
    if (current.length >= MAX_ROWS_PER_FRAME || bytes + rowBytes > MAX_FRAME_BYTES) {
      chunks.push(current);
      current = [];
      bytes = 2;
    }
    current.push(row);
    bytes += rowBytes;
  }
  chunks.push(current);
  return chunks.map((rows, index) => ({
    rows,
    advanceTo: index === chunks.length - 1
      ? frame.advanceTo
      : rows[rows.length - 1]!.ordinal,
  }));
}

function searchFrames(
  query: ChatSearchQueryV1,
  allowedChats: readonly TranscriptSearchAllowedChat[],
  limit: number,
): readonly WorkerRequestInput<ReaderRequest>[] {
  const frames: WorkerRequestInput<ReaderRequest>[] = [{ type: 'search-start', query, limit }];
  if (allowedChats.length === 0) {
    frames.push({
      type: 'search-allowlist-chunk',
      chunkIndex: 0,
      allowedChats: [],
      done: true,
    });
    return frames;
  }
  for (let offset = 0; offset < allowedChats.length; offset += MAX_ALLOWLIST_PER_FRAME) {
    const chunk = allowedChats.slice(offset, offset + MAX_ALLOWLIST_PER_FRAME);
    if (Buffer.byteLength(JSON.stringify(chunk)) > MAX_FRAME_BYTES) {
      throw new Error('SEARCH_ALLOWLIST_TOO_LARGE');
    }
    frames.push({
      type: 'search-allowlist-chunk',
      chunkIndex: offset / MAX_ALLOWLIST_PER_FRAME,
      allowedChats: chunk,
      done: offset + chunk.length >= allowedChats.length,
    });
  }
  return frames;
}

function workerEventError(event: IndexerEvent | ReaderEvent): Error | null {
  return event.type === 'error'
    ? new TranscriptSearchWorkerError(event.code, event.retryable)
    : null;
}

function isRepairableIndexPositionError(error: unknown): boolean {
  return error instanceof Error
    && (error.message === 'SEARCH_INDEX_GAP' || error.message === 'SEARCH_VIEW_MISMATCH');
}

function indexFailureCode(error: unknown): string {
  return error instanceof Error && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.message)
    ? error.message
    : 'SEARCH_INDEX_UNAVAILABLE';
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
