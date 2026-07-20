import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChatMessage } from '@garcon/common/chat-types';
import type { ChatSearchIndexStatus, ChatSearchQueryV1, ChatSearchResult } from '@garcon/common/chat-search';
import type {
  AgentLogger,
  AgentTranscriptIndexModuleReference,
  AgentTranscriptIndexSourceRef,
} from '@garcon/server-agent-interface';
import {
  isEmbeddedStandaloneEntrypoint,
  resolveSearchWorkerEntrypoints,
} from '../build/standalone-entrypoint.js';
import type {
  IndexerEvent,
  IndexerRequest,
  ReaderEvent,
  ReaderRequest,
  TranscriptIndexModuleRegistration,
} from './worker-protocol.js';
import { compareGeneration, isIndexerEvent, isReaderEvent } from './worker-protocol.js';
import { canonicalDigest } from './digest.js';
import {
  SearchWorkerSupervisor,
  type WorkerRequestInput,
} from './worker-supervisor.js';

const SEARCH_DIRECTORY = 'transcript-search';
const REQUEST_TIMEOUT_MS = 30_000;
const SEARCH_TIMEOUT_MS = 5_000;
const MAX_CARRY_MESSAGES = 250;
const MAX_CARRY_BYTES = 8 * 1024 * 1024;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_CATALOG_ENTRIES_PER_FRAME = 500;
const MAX_ALLOWLIST_IDS_PER_FRAME = 2_000;
const DIRTY_HINT_COALESCE_MS = 100;
const READER_ADMISSION_RETRY_DELAYS_MS = [0, 50, 250, 1_000] as const;
const CLEANUP_RETRY_DELAYS_MS = [0, 100, 1_000] as const;
const WORKER_CLOSE_TIMEOUT_MS = 5_000;
const POISON_CHAT_CRASH_LIMIT = 3;

export interface TranscriptSearchGeneration {
  readonly epoch: string;
  readonly sequence: number;
}

export interface TranscriptSearchCatalogEntry {
  readonly chatId: string;
  readonly agentId: string;
  readonly model: string;
  readonly updatedAt: string | null;
  readonly source:
    | { readonly state: 'ready'; readonly reference: AgentTranscriptIndexSourceRef }
    | { readonly state: 'absent' }
    | { readonly state: 'failed'; readonly code: string; readonly retryable: boolean };
  readonly carryOverRevision: string;
}

export interface TranscriptSearchCatalogSnapshot {
  readonly generation: TranscriptSearchGeneration;
  readonly chats: readonly TranscriptSearchCatalogEntry[];
}

export interface TranscriptSearchCarryOverRequest {
  readonly chatId: string;
  readonly expectedRevision: string;
  readonly currentAgentId: string;
  readonly currentModel: string;
  readonly signal: AbortSignal;
  readonly limits: {
    readonly maxMessagesPerBatch: number;
    readonly maxBatchBytes: number;
  };
}

export interface TranscriptSearchCarryOverStream {
  readonly revision: string;
  readonly batches: AsyncIterable<readonly ChatMessage[]>;
}

export type TranscriptSearchCarryOverFailure =
  | { readonly kind: 'transcript-search-carry-over-failure'; readonly code: 'CARRY_OVER_REVISION_CHANGED'; readonly retryable: true }
  | { readonly kind: 'transcript-search-carry-over-failure'; readonly code: 'CARRY_OVER_MESSAGE_TOO_LARGE'; readonly retryable: false }
  | { readonly kind: 'transcript-search-carry-over-failure'; readonly code: 'CARRY_OVER_UNAVAILABLE'; readonly retryable: boolean };

export class TranscriptSearchCarryOverError extends Error {
  override readonly name = 'TranscriptSearchCarryOverError';
  constructor(readonly failure: TranscriptSearchCarryOverFailure) {
    super(failure.code);
  }
}

export interface TranscriptSearchServiceOptions {
  readonly workspaceDirectory: string;
  readonly logger: AgentLogger;
  readonly openCarryOverStream: (
    request: TranscriptSearchCarryOverRequest,
  ) => Promise<TranscriptSearchCarryOverStream>;
  readonly workerFactory?: (role: 'indexer' | 'reader', moduleUrl: string) => Worker;
}

type CarryState = {
  readonly controller: AbortController;
  readonly iterator: AsyncIterator<readonly ChatMessage[]>;
  readonly revision: string;
  readonly lifecycleEpoch: string;
  nextChunkIndex: number;
  pulling: boolean;
};

type SearchQueueItem = {
  readonly query: ChatSearchQueryV1;
  readonly allowedChatIds: readonly string[];
  readonly limit: number;
  readonly deadline: number;
  readonly controller: AbortController;
  readonly removeExternalAbort: () => void;
  removeInternalAbort: () => void;
  readonly timer: ReturnType<typeof setTimeout>;
  resolve(event: Extract<ReaderEvent, { type: 'search-result' }>): void;
  reject(error: Error): void;
};

export interface TranscriptSearchSourceRefreshRequest {
  readonly chatId: string;
  readonly agentId: string;
  readonly failedSource: AgentTranscriptIndexSourceRef;
  readonly failureCode: string;
  readonly signal: AbortSignal;
}

export class TranscriptSearchService {
  readonly #options: TranscriptSearchServiceOptions;
  readonly #operationEpoch = crypto.randomUUID();
  readonly #searchDirectory: string;
  readonly #dbPath: string;
  readonly #scratchDirectory: string;
  readonly #indexer: SearchWorkerSupervisor<IndexerRequest, IndexerEvent>;
  readonly #reader: SearchWorkerSupervisor<ReaderRequest, ReaderEvent>;
  readonly #carryStreams = new Map<number, CarryState>();
  readonly #dirtyReplay = new Map<string, TranscriptSearchGeneration>();
  readonly #dirtyDispatchTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #deleteTombstones = new Map<string, TranscriptSearchGeneration>();
  readonly #refreshControllers = new Set<AbortController>();
  readonly #refreshTasks = new Set<Promise<void>>();
  readonly #searchQueue: SearchQueueItem[] = [];
  readonly #indexerCrashHistory = new Map<string, { sourceSignature: string; count: number }>();
  readonly #indexerQuarantines = new Map<string, string>();
  #modules: readonly TranscriptIndexModuleRegistration[] = [];
  #latestCatalog: TranscriptSearchCatalogSnapshot | null = null;
  #latestStatus: ChatSearchIndexStatus = {
    indexedChatCount: 0,
    pendingChatCount: 0,
    failedChatCount: 0,
    unsupportedChatCount: 0,
  };
  #enabled = false;
  #closed = false;
  #sourceRefreshHandler: ((request: TranscriptSearchSourceRefreshRequest) => Promise<void>) | null = null;
  #catalogRefreshHandler: ((chatId: string) => void) | null = null;
  #activeSearch: SearchQueueItem | null = null;
  #activeIndexerJob: { chatId: string; sourceSignature: string } | null = null;

  constructor(options: TranscriptSearchServiceOptions) {
    this.#options = options;
    this.#searchDirectory = path.join(options.workspaceDirectory, SEARCH_DIRECTORY);
    this.#dbPath = path.join(this.#searchDirectory, 'index.sqlite');
    this.#scratchDirectory = path.join(this.#searchDirectory, 'scratch');
    const entrypoints = resolveSearchWorkerEntrypoints({
      indexerSourceUrl: new URL('./indexer-main.ts', import.meta.url),
      readerSourceUrl: new URL('./reader-main.ts', import.meta.url),
    });
    this.#indexer = new SearchWorkerSupervisor({
      role: 'indexer',
      moduleUrl: entrypoints.indexer,
      logger: options.logger,
      workerFactory: options.workerFactory,
      isEvent: isIndexerEvent,
      eventError: workerEventError,
      shouldRestart: () => this.#enabled && !this.#closed,
      admit: async (signal) => {
        const event = await this.#requestIndexer({
          type: 'open',
          operationEpoch: this.#operationEpoch,
          dbPath: this.#dbPath,
          scratchDirectory: this.#scratchDirectory,
          modules: this.#modules,
          quarantines: [...this.#indexerQuarantines].map(([chatId, sourceSignature]) => ({
            chatId,
            sourceSignature,
          })),
        }, signal);
        if (event.type !== 'opened') throw new Error('Transcript indexer admission failed');
      },
      afterRestart: () => this.#replayIndexerState(),
      onEvent: (event) => this.#handleIndexerEvent(event),
      onCrash: () => this.#handleIndexerCrash(),
    });
    this.#reader = new SearchWorkerSupervisor({
      role: 'reader',
      moduleUrl: entrypoints.reader,
      logger: options.logger,
      workerFactory: options.workerFactory,
      isEvent: isReaderEvent,
      eventError: workerEventError,
      shouldRestart: () => this.#enabled && !this.#closed,
      admit: async (signal) => {
        const event = await this.#requestReader({ type: 'open', dbPath: this.#dbPath }, signal);
        if (event.type !== 'opened') throw new Error('Transcript reader admission failed');
      },
      afterRestart: async () => this.#drainSearchQueue(),
      onEvent: (event) => this.#handleReaderEvent(event),
      onCrash: () => {},
    });
  }

  async enable(request: {
    readonly modules: readonly { agentId: string; reference: AgentTranscriptIndexModuleReference }[];
    readonly signal: AbortSignal;
  }): Promise<void> {
    if (this.#closed) throw new Error('Transcript search service is closed');
    if (this.#enabled) return;
    request.signal.throwIfAborted();
    this.#modules = request.modules.map(({ agentId, reference }) => ({
      agentId,
      moduleUrl: reference.moduleUrl,
      apiVersion: reference.apiVersion,
    }));
    await cleanupObsoleteSearchArtifacts(this.#options.workspaceDirectory, this.#options.logger);
    await Promise.all(this.#modules.map((module) => validateModuleAsset(module.moduleUrl)));
    await fs.mkdir(this.#searchDirectory, { recursive: true, mode: 0o700 });
    await fs.chmod(this.#searchDirectory, 0o700);
    try {
      await this.#startIndexer(request.signal);
      await this.#startReader(request.signal);
      request.signal.throwIfAborted();
      this.#enabled = true;
    } catch (error) {
      await this.#stopWorkers();
      throw error;
    }
  }

  async reconcile(snapshot: TranscriptSearchCatalogSnapshot): Promise<void> {
    if (!this.#enabled || this.#closed) return;
    if (snapshot.generation.epoch !== this.#operationEpoch) {
      throw new Error('Transcript search catalog epoch is invalid');
    }
    if (this.#latestCatalog
        && snapshot.generation.sequence < this.#latestCatalog.generation.sequence) return;
    const chats = snapshot.chats.filter((entry) => {
      const tombstone = this.#deleteTombstones.get(entry.chatId);
      if (!tombstone) return true;
      const ordering = compareGeneration(snapshot.generation, tombstone);
      if (ordering !== null && ordering > 0) {
        this.#deleteTombstones.delete(entry.chatId);
        return true;
      }
      return false;
    });
    const allowed = new Set(chats.map((entry) => entry.chatId));
    for (const [chatId, tombstone] of this.#deleteTombstones) {
      const ordering = compareGeneration(snapshot.generation, tombstone);
      if (ordering !== null && ordering > 0 && !allowed.has(chatId)) {
        this.#deleteTombstones.delete(chatId);
      }
    }
    const filteredSnapshot = { ...snapshot, chats };
    this.#latestCatalog = filteredSnapshot;
    for (const chatId of this.#dirtyReplay.keys()) {
      if (!allowed.has(chatId)) this.#dirtyReplay.delete(chatId);
    }
    await this.#requestIndexerFrames(catalogFrames(filteredSnapshot));
  }

  sourceMayHaveChanged(request: {
    readonly chatId: string;
    readonly generation: TranscriptSearchGeneration;
  }): void {
    if (!this.#enabled || this.#closed) return;
    const tombstone = this.#deleteTombstones.get(request.chatId);
    if (tombstone && (compareGeneration(request.generation, tombstone) ?? -1) <= 0) return;
    const current = this.#dirtyReplay.get(request.chatId);
    if (!current || (compareGeneration(request.generation, current) ?? -1) > 0) {
      this.#dirtyReplay.set(request.chatId, request.generation);
    }
    if (this.#dirtyDispatchTimers.has(request.chatId)) return;
    const timer = setTimeout(() => {
      this.#dirtyDispatchTimers.delete(request.chatId);
      const generation = this.#dirtyReplay.get(request.chatId);
      if (!generation || !this.#enabled || this.#closed) return;
      void this.#requestIndexer({ type: 'source-dirty', chatId: request.chatId, generation })
        .catch(() => undefined);
    }, DIRTY_HINT_COALESCE_MS);
    timer.unref?.();
    this.#dirtyDispatchTimers.set(request.chatId, timer);
  }

  deleteChat(request: {
    readonly chatId: string;
    readonly generation: TranscriptSearchGeneration;
  }): void {
    if (!this.#enabled || this.#closed) return;
    this.#dirtyReplay.delete(request.chatId);
    const dirtyTimer = this.#dirtyDispatchTimers.get(request.chatId);
    if (dirtyTimer) clearTimeout(dirtyTimer);
    this.#dirtyDispatchTimers.delete(request.chatId);
    this.#indexerCrashHistory.delete(request.chatId);
    this.#indexerQuarantines.delete(request.chatId);
    const currentTombstone = this.#deleteTombstones.get(request.chatId);
    if (!currentTombstone || (compareGeneration(request.generation, currentTombstone) ?? -1) > 0) {
      this.#deleteTombstones.set(request.chatId, request.generation);
    }
    if (this.#latestCatalog) {
      this.#latestCatalog = {
        ...this.#latestCatalog,
        chats: this.#latestCatalog.chats.filter((entry) => entry.chatId !== request.chatId),
      };
    }
    void this.#requestIndexer({ type: 'delete-chat', ...request }).catch(() => undefined);
  }

  async search(request: {
    readonly query: ChatSearchQueryV1;
    readonly allowedChatIds: readonly string[];
    readonly limit: number;
    readonly signal: AbortSignal;
  }): Promise<{ readonly results: readonly ChatSearchResult[]; readonly index: ChatSearchIndexStatus }> {
    if (!this.#enabled || this.#closed || !this.#reader.available) {
      throw new Error('SEARCH_INDEX_UNAVAILABLE');
    }
    request.signal.throwIfAborted();
    const event = await this.#enqueueSearch(request);
    const allowed = new Set(request.allowedChatIds);
    if (event.results.some((result) => !allowed.has(result.chatId))) {
      throw new Error('SEARCH_INDEX_INVALID_RESPONSE');
    }
    return { results: event.results, index: event.index };
  }

  #enqueueSearch(request: {
    readonly query: ChatSearchQueryV1;
    readonly allowedChatIds: readonly string[];
    readonly limit: number;
    readonly signal: AbortSignal;
  }): Promise<Extract<ReaderEvent, { type: 'search-result' }>> {
    const controller = new AbortController();
    const deadline = Date.now() + SEARCH_TIMEOUT_MS;
    const abortFromRequest = () => controller.abort(request.signal.reason);
    request.signal.addEventListener('abort', abortFromRequest, { once: true });
    if (request.signal.aborted) abortFromRequest();
    const removeExternalAbort = () => request.signal.removeEventListener('abort', abortFromRequest);
    const timer = setTimeout(
      () => controller.abort(new Error('SEARCH_TIMEOUT')),
      SEARCH_TIMEOUT_MS,
    );
    timer.unref?.();
    return new Promise((resolve, reject) => {
      const item: SearchQueueItem = {
        query: request.query,
        allowedChatIds: request.allowedChatIds,
        limit: request.limit,
        deadline,
        controller,
        removeExternalAbort,
        timer,
        removeInternalAbort: () => {},
        resolve,
        reject,
      };
      const abortQueued = (): void => {
        if (this.#activeSearch === item) return;
        const index = this.#searchQueue.indexOf(item);
        if (index >= 0) this.#searchQueue.splice(index, 1);
        this.#finishSearchItem(item);
        reject(controller.signal.reason instanceof Error
          ? controller.signal.reason
          : new DOMException('Aborted', 'AbortError'));
      };
      controller.signal.addEventListener('abort', abortQueued, { once: true });
      item.removeInternalAbort = () => controller.signal.removeEventListener('abort', abortQueued);
      this.#searchQueue.push(item);
      if (controller.signal.aborted) abortQueued();
      this.#drainSearchQueue();
    });
  }

  #drainSearchQueue(): void {
    if (this.#activeSearch || !this.#reader.available || !this.#enabled || this.#closed) return;
    const item = this.#searchQueue.shift();
    if (!item) return;
    if (item.controller.signal.aborted || item.deadline <= Date.now()) {
      this.#finishSearchItem(item);
      item.reject(new Error('SEARCH_TIMEOUT'));
      this.#drainSearchQueue();
      return;
    }
    this.#activeSearch = item;
    void this.#requestReaderFrames(
      searchFrames(item.query, item.allowedChatIds, item.limit),
      item.controller.signal,
      Math.max(1, item.deadline - Date.now()),
    ).then((event) => {
      if (event.type !== 'search-result') throw new Error('SEARCH_INDEX_UNAVAILABLE');
      item.resolve(event);
    }).catch((error) => {
      item.reject(error instanceof Error ? error : new Error(String(error)));
    }).finally(() => {
      this.#finishSearchItem(item);
      if (this.#activeSearch === item) this.#activeSearch = null;
      this.#drainSearchQueue();
    });
  }

  #finishSearchItem(item: SearchQueueItem): void {
    clearTimeout(item.timer);
    item.removeExternalAbort();
    item.removeInternalAbort();
  }

  #cancelSearchQueue(message: string): void {
    this.#activeSearch?.controller.abort(new Error(message));
    for (const item of this.#searchQueue.splice(0)) {
      this.#finishSearchItem(item);
      item.reject(new Error(message));
    }
  }

  async disableAndDelete(signal: AbortSignal): Promise<void> {
    this.#enabled = false;
    this.#cancelSearchQueue('Transcript search disabled');
    this.#clearDirtyDispatchTimers();
    for (const controller of this.#refreshControllers) controller.abort();
    await Promise.allSettled(this.#refreshTasks);
    signal.throwIfAborted();
    await this.#stopWorkers();
    await removeDirectoryWithRetry(this.#searchDirectory, signal);
    await cleanupObsoleteSearchArtifacts(this.#options.workspaceDirectory, this.#options.logger);
    this.#latestCatalog = null;
    this.#latestStatus = {
      indexedChatCount: 0,
      pendingChatCount: 0,
      failedChatCount: 0,
      unsupportedChatCount: 0,
    };
    this.#dirtyReplay.clear();
    this.#deleteTombstones.clear();
    this.#indexerCrashHistory.clear();
    this.#indexerQuarantines.clear();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#enabled = false;
    this.#cancelSearchQueue('Transcript search closed');
    this.#clearDirtyDispatchTimers();
    for (const controller of this.#refreshControllers) controller.abort();
    await Promise.allSettled(this.#refreshTasks);
    await this.#stopWorkers();
  }

  setSourceRefreshHandler(
    handler: (request: TranscriptSearchSourceRefreshRequest) => Promise<void>,
  ): void {
    if (this.#enabled) throw new Error('Transcript search refresh handler must be set before enablement');
    this.#sourceRefreshHandler = handler;
  }

  setCatalogRefreshHandler(handler: (chatId: string) => void): void {
    if (this.#enabled) throw new Error('Transcript search catalog handler must be set before enablement');
    this.#catalogRefreshHandler = handler;
  }

  operationEpoch(): string {
    return this.#operationEpoch;
  }

  indexStatus(): ChatSearchIndexStatus {
    return this.#latestStatus;
  }

  #clearDirtyDispatchTimers(): void {
    for (const timer of this.#dirtyDispatchTimers.values()) clearTimeout(timer);
    this.#dirtyDispatchTimers.clear();
  }

  async #startIndexer(signal: AbortSignal): Promise<void> {
    await this.#indexer.start(signal);
  }

  async #startReader(signal: AbortSignal): Promise<void> {
    let lastError: unknown = new Error('Transcript reader admission failed');
    for (const delayMs of READER_ADMISSION_RETRY_DELAYS_MS) {
      if (delayMs > 0) await abortableDelay(delayMs, signal);
      try {
        await this.#startReaderOnce(signal);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  async #startReaderOnce(signal: AbortSignal): Promise<void> {
    await this.#reader.start(signal);
  }

  #handleIndexerEvent(event: IndexerEvent): void {
    if (event.type === 'progress') {
      this.#latestStatus = event.status;
      return;
    }
    if (event.type === 'source-status') {
      this.#handleSourceStatus(event);
      return;
    }
    if (event.type === 'refresh-source-reference') {
      const task = this.#refreshSourceReference(event).catch(() => {
        this.#options.logger.warn('Transcript source refresh dispatch failed.', {
          code: 'SEARCH_SOURCE_REFRESH_DISPATCH_FAILED',
        });
      });
      this.#refreshTasks.add(task);
      void task.finally(() => this.#refreshTasks.delete(task));
      return;
    }
    if (event.type === 'job-state') {
      if (event.state === 'started') {
        this.#activeIndexerJob = {
          chatId: event.chatId,
          sourceSignature: event.sourceSignature,
        };
        const quarantined = this.#indexerQuarantines.get(event.chatId);
        if (quarantined && quarantined !== event.sourceSignature) {
          this.#indexerQuarantines.delete(event.chatId);
          this.#indexerCrashHistory.delete(event.chatId);
        }
        const crashHistory = this.#indexerCrashHistory.get(event.chatId);
        if (crashHistory && crashHistory.sourceSignature !== event.sourceSignature) {
          this.#indexerCrashHistory.delete(event.chatId);
        }
      } else if (this.#activeIndexerJob?.chatId === event.chatId
          && this.#activeIndexerJob.sourceSignature === event.sourceSignature) {
        this.#activeIndexerJob = null;
        this.#indexerCrashHistory.delete(event.chatId);
      }
      return;
    }
    if (event.type === 'fatal') {
      this.#options.logger.warn('Transcript indexer reported a fatal storage failure.', {
        code: event.code,
      });
      this.#activeIndexerJob = null;
      this.#indexer.crash();
      return;
    }
    if (event.type === 'carry-over-open') {
      void this.#openCarryStream(event);
      return;
    }
    if (event.type === 'carry-over-pull') {
      void this.#pullCarryStream(event.requestId);
      return;
    }
    if (event.type === 'carry-over-cancel') {
      void this.#closeCarryStream(event.requestId);
      return;
    }
  }

  #handleSourceStatus(event: Extract<IndexerEvent, { type: 'source-status' }>): void {
    if (event.state === 'failed' && event.errorCode === 'CARRY_OVER_REVISION_CHANGED') {
      this.#catalogRefreshHandler?.(event.chatId);
    }
    const dirty = this.#dirtyReplay.get(event.chatId);
    if (!dirty) return;
    const ordering = compareGeneration(event.generation, dirty);
    if (ordering === null || ordering < 0) return;
    if (event.state === 'sealed' || event.state === 'unsupported'
        || (event.state === 'failed' && event.retryable === false)) {
      this.#dirtyReplay.delete(event.chatId);
    }
  }

  async #refreshSourceReference(
    event: Extract<IndexerEvent, { type: 'refresh-source-reference' }>,
  ): Promise<void> {
    const handler = this.#sourceRefreshHandler;
    const catalogEntry = this.#latestCatalog?.chats.find((entry) => entry.chatId === event.chatId);
    if (!handler || !catalogEntry || catalogEntry.agentId !== event.agentId
        || catalogEntry.source.state !== 'ready'
        || canonicalDigest(catalogEntry.source.reference) !== event.sourceDescriptorHash) return;
    const dirtyGeneration = this.#dirtyReplay.get(event.chatId);
    if (dirtyGeneration && (compareGeneration(event.generation, dirtyGeneration) ?? -1) < 0) return;
    const controller = new AbortController();
    this.#refreshControllers.add(controller);
    try {
      await handler({
        chatId: event.chatId,
        agentId: event.agentId,
        failedSource: catalogEntry.source.reference,
        failureCode: event.reasonCode,
        signal: controller.signal,
      });
    } catch {
      this.#options.logger.warn('Transcript source refresh failed.', {
        code: 'SEARCH_SOURCE_REFRESH_FAILED',
        agentId: event.agentId,
      });
    } finally {
      this.#refreshControllers.delete(controller);
    }
  }

  #handleReaderEvent(event: ReaderEvent): void {
    if (event.type === 'error' && event.code === 'READER_INTERNAL') {
      this.#reader.crash();
    }
  }

  async #openCarryStream(event: Extract<IndexerEvent, { type: 'carry-over-open' }>): Promise<void> {
    const controller = new AbortController();
    try {
      const stream = await this.#options.openCarryOverStream({
        chatId: event.chatId,
        expectedRevision: event.expectedRevision,
        currentAgentId: event.currentAgentId,
        currentModel: event.currentModel,
        signal: controller.signal,
        limits: { maxMessagesPerBatch: MAX_CARRY_MESSAGES, maxBatchBytes: MAX_CARRY_BYTES },
      });
      if (stream.revision !== event.expectedRevision) throw new Error('CARRY_OVER_REVISION_CHANGED');
      const iterator = stream.batches[Symbol.asyncIterator]();
      if (!this.#indexer.available || event.lifecycleEpoch !== this.#indexer.epoch) {
        controller.abort();
        await iterator.return?.();
        return;
      }
      this.#carryStreams.set(event.requestId, {
        controller,
        iterator,
        revision: stream.revision,
        lifecycleEpoch: event.lifecycleEpoch,
        nextChunkIndex: 0,
        pulling: false,
      });
      await this.#pullCarryStream(event.requestId);
    } catch (error) {
      controller.abort();
      this.#postCarryError(event.requestId, event.expectedRevision, error, event.lifecycleEpoch);
    }
  }

  async #pullCarryStream(requestId: number): Promise<void> {
    const stream = this.#carryStreams.get(requestId);
    if (!stream || stream.pulling || !this.#indexer.available
        || stream.lifecycleEpoch !== this.#indexer.epoch) return;
    stream.pulling = true;
    try {
      const next = await stream.iterator.next();
      if (this.#carryStreams.get(requestId) !== stream
          || stream.lifecycleEpoch !== this.#indexer.epoch || !this.#indexer.available) return;
      const messages = next.value ? [...next.value] : [];
      const bytes = Buffer.byteLength(JSON.stringify(messages));
      if (messages.length > MAX_CARRY_MESSAGES || bytes > MAX_CARRY_BYTES) {
        throw new Error('CARRY_OVER_MESSAGE_TOO_LARGE');
      }
      stream.pulling = false;
      this.#postIndexer({
        type: 'carry-over-chunk',
        requestId,
        lifecycleEpoch: stream.lifecycleEpoch,
        chunkIndex: stream.nextChunkIndex,
        revision: stream.revision,
        messages,
        done: Boolean(next.done),
      });
      stream.nextChunkIndex += 1;
      if (next.done) await this.#closeCarryStream(requestId);
    } catch (error) {
      this.#postCarryError(requestId, stream.revision, error, stream.lifecycleEpoch);
      await this.#closeCarryStream(requestId);
    } finally {
      stream.pulling = false;
    }
  }

  #postCarryError(
    requestId: number,
    revision: string,
    error: unknown,
    lifecycleEpoch: string,
  ): void {
    if (lifecycleEpoch !== this.#indexer.epoch || !this.#indexer.available) return;
    const typedFailure = error instanceof TranscriptSearchCarryOverError ? error.failure : null;
    const code = typedFailure?.code
      ?? (error instanceof Error && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.message)
        ? error.message
        : 'CARRY_OVER_UNAVAILABLE');
    this.#postIndexer({
      type: 'carry-over-chunk',
      requestId,
      lifecycleEpoch,
      chunkIndex: this.#carryStreams.get(requestId)?.nextChunkIndex ?? 0,
      revision,
      messages: [],
      done: true,
      code,
      retryable: typedFailure?.retryable ?? code !== 'CARRY_OVER_MESSAGE_TOO_LARGE',
    });
  }

  async #closeCarryStream(requestId: number): Promise<void> {
    const stream = this.#carryStreams.get(requestId);
    if (!stream) return;
    this.#carryStreams.delete(requestId);
    stream.controller.abort();
    await stream.iterator.return?.().catch(() => undefined);
  }

  #requestIndexer(
    input: WorkerRequestInput<IndexerRequest>,
    signal?: AbortSignal,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<IndexerEvent> {
    return this.#indexer.request([input], signal, timeoutMs);
  }

  #requestIndexerFrames(
    inputs: readonly WorkerRequestInput<IndexerRequest>[],
    signal?: AbortSignal,
  ): Promise<IndexerEvent> {
    return this.#indexer.request(inputs, signal, REQUEST_TIMEOUT_MS);
  }

  #requestReader(
    input: WorkerRequestInput<ReaderRequest>,
    signal?: AbortSignal,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<ReaderEvent> {
    return this.#reader.request([input], signal, timeoutMs);
  }

  #requestReaderFrames(
    inputs: readonly WorkerRequestInput<ReaderRequest>[],
    signal?: AbortSignal,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<ReaderEvent> {
    return this.#reader.request(inputs, signal, timeoutMs);
  }

  #postIndexer(message: IndexerRequest): void {
    this.#indexer.post(message);
  }

  #handleIndexerCrash(): void {
    const active = this.#activeIndexerJob;
    this.#activeIndexerJob = null;
    if (active) {
      const previous = this.#indexerCrashHistory.get(active.chatId);
      const count = previous?.sourceSignature === active.sourceSignature
        ? previous.count + 1
        : 1;
      this.#indexerCrashHistory.set(active.chatId, {
        sourceSignature: active.sourceSignature,
        count,
      });
      if (count >= POISON_CHAT_CRASH_LIMIT) {
        this.#indexerQuarantines.set(active.chatId, active.sourceSignature);
        this.#options.logger.warn('Transcript source quarantined after repeated indexer crashes.', {
          code: 'SEARCH_SOURCE_QUARANTINED',
        });
      }
    }
    for (const requestId of this.#carryStreams.keys()) {
      void this.#closeCarryStream(requestId);
    }
  }

  async #replayIndexerState(): Promise<void> {
    if (this.#latestCatalog) {
      await this.#requestIndexerFrames(catalogFrames(this.#latestCatalog));
    }
    for (const [chatId, generation] of this.#deleteTombstones) {
      await this.#requestIndexer({ type: 'delete-chat', chatId, generation });
    }
    for (const [chatId, generation] of this.#dirtyReplay) {
      await this.#requestIndexer({ type: 'source-dirty', chatId, generation });
    }
  }

  async #stopWorkers(): Promise<void> {
    this.#activeIndexerJob = null;
    await Promise.all([...this.#carryStreams.keys()].map((requestId) => this.#closeCarryStream(requestId)));
    await this.#reader.stop({ type: 'close' }, WORKER_CLOSE_TIMEOUT_MS);
    await this.#indexer.stop({ type: 'close' }, WORKER_CLOSE_TIMEOUT_MS);
  }
}

function workerEventError(event: IndexerEvent | ReaderEvent): Error | null {
  return event.type === 'error'
    ? Object.assign(new Error(event.code), { retryable: event.retryable })
    : null;
}

async function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(finish, delayMs);
    timer.unref?.();
    const onAbort = (): void => finish(signal.reason instanceof Error
      ? signal.reason
      : new DOMException('Aborted', 'AbortError'));
    function finish(error?: Error): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    }
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

async function removeDirectoryWithRetry(directory: string, signal: AbortSignal): Promise<void> {
  let lastError: unknown = new Error('Transcript search cleanup failed');
  for (const delayMs of CLEANUP_RETRY_DELAYS_MS) {
    if (delayMs > 0) await abortableDelay(delayMs, signal);
    try {
      await fs.rm(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function validateModuleAsset(moduleUrl: string): Promise<void> {
  const filePath = moduleUrl.startsWith('file:') ? fileURLToPath(moduleUrl) : moduleUrl;
  if (isEmbeddedStandaloneEntrypoint(filePath)) return;
  await fs.access(filePath);
}

export async function cleanupObsoleteSearchArtifacts(
  workspaceDirectory: string,
  logger: AgentLogger,
): Promise<void> {
  const candidates = [
    'chat-search.sqlite', 'chat-search.sqlite-wal', 'chat-search.sqlite-shm',
    'chat-search-v3.sqlite', 'chat-search-v3.sqlite-wal', 'chat-search-v3.sqlite-shm',
    '.chat-search-v3-tmp',
  ].map((name) => path.join(workspaceDirectory, name));
  const agentData = path.join(workspaceDirectory, 'agent-data');
  try {
    const children = await fs.readdir(agentData, { withFileTypes: true });
    for (const child of children) {
      if (child.isDirectory() && !child.isSymbolicLink()) {
        candidates.push(path.join(agentData, child.name, 'transcript-search'));
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn('Obsolete transcript search discovery failed.', { code: 'SEARCH_CLEANUP_DISCOVERY_FAILED' });
    }
  }
  await Promise.all(candidates.map(async (candidate) => {
    try {
      await fs.rm(candidate, { recursive: true, force: true });
    } catch {
      logger.warn('Obsolete transcript search cleanup failed.', { code: 'SEARCH_CLEANUP_FAILED' });
    }
  }));
}

function boundedFrames<T>(
  values: readonly T[],
  maxEntries: number,
): T[][] {
  const frames: T[][] = [];
  let frame: T[] = [];
  let frameBytes = 2;
  for (const value of values) {
    const bytes = Buffer.byteLength(JSON.stringify(value)) + 1;
    if (bytes > MAX_FRAME_BYTES) throw new Error('TRANSCRIPT_SEARCH_FRAME_ENTRY_TOO_LARGE');
    if (frame.length > 0 && (frame.length >= maxEntries || frameBytes + bytes > MAX_FRAME_BYTES)) {
      frames.push(frame);
      frame = [];
      frameBytes = 2;
    }
    frame.push(value);
    frameBytes += bytes;
  }
  if (frame.length > 0 || frames.length === 0) frames.push(frame);
  return frames;
}

function catalogFrames(
  snapshot: TranscriptSearchCatalogSnapshot,
): Array<WorkerRequestInput<IndexerRequest>> {
  const frames = boundedFrames(snapshot.chats, MAX_CATALOG_ENTRIES_PER_FRAME);
  return frames.map((chats, chunkIndex) => ({
    type: 'catalog-chunk',
    generation: snapshot.generation,
    chunkIndex,
    chats,
    done: chunkIndex === frames.length - 1,
  }));
}

function searchFrames(
  query: ChatSearchQueryV1,
  allowedChatIds: readonly string[],
  limit: number,
): Array<WorkerRequestInput<ReaderRequest>> {
  const frames = boundedFrames(allowedChatIds, MAX_ALLOWLIST_IDS_PER_FRAME);
  return [
    { type: 'search-start', query, limit },
    ...frames.map((ids, chunkIndex) => ({
      type: 'search-allowlist-chunk' as const,
      chunkIndex,
      allowedChatIds: ids,
      done: chunkIndex === frames.length - 1,
    })),
  ];
}
