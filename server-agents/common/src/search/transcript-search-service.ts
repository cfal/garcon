import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  ChatSearchIndexStatus,
  ChatSearchQueryV1,
  ChatSearchResult,
  TranscriptSearchAllowedChat,
} from '@garcon/common/chat-search';
import { resolveSearchWorkerEntrypoints } from '../build/standalone-entrypoint.js';
import type { HistoricalSearchMessageRow } from './rows.js';
import {
  SEARCH_RAW_STAGE_MAX_BYTES,
  SEARCH_RAW_STAGE_MAX_ROWS,
} from './schema.js';
import type {
  IndexerEvent,
  IndexerPhysicalStep,
  IndexerRequest,
  PhysicalStepResult,
  PrunedChatCleanup,
  ReaderEvent,
  ReaderRequest,
  SearchChatState,
  WalObservation,
} from './worker-protocol.js';
import {
  SEARCH_MAX_DIRTY_FRAMES,
  SEARCH_READER_MAX_ALLOWLIST_ROWS,
  SEARCH_WAL_HIGH_WATER_FRAMES,
  SEARCH_WORKER_PHYSICAL_STEP_TIMEOUT_MS,
  SEARCH_WORKER_STEP_START_TIMEOUT_MS,
  isIndexerEvent,
  isNewerWalObservation,
  isReaderEvent,
  physicalStepResultRequiresSecureBarrier,
  workerEnvelopeWithinLimit,
} from './worker-protocol.js';
import {
  TranscriptSearchWorkerError,
  grantMatches,
  isKnownIndexerGrantError,
  isReplacementCheckpointResult,
  recordableBuildFailureCode,
  requireIndexInput,
  resultState,
  workerEventError,
  type TranscriptSearchIndexInput,
  type TranscriptSearchServiceOptions,
} from './transcript-search-service-contract.js';
import {
  SearchWorkerSupervisor,
  type SearchWorkerRequestSession,
  type WorkerRequestInput,
} from './worker-supervisor.js';

export type { PrunedChatCleanup } from './worker-protocol.js';
export { TranscriptSearchWorkerError } from './transcript-search-service-contract.js';
export type {
  TranscriptSearchIndexInput,
  TranscriptSearchServiceOptions,
} from './transcript-search-service-contract.js';

const SEARCH_DIRECTORY = 'transcript-search';
const REQUEST_TIMEOUT_MS = 30_000;
const SEARCH_TIMEOUT_MS = 30_000;
const WORKER_CLOSE_TIMEOUT_MS = 30_000;
const MAX_CONSECUTIVE_LIVE_GRANTS = 8;

type PhysicalLane = 'live' | 'cleanup';
type IndexerCompleteEvent = Extract<IndexerEvent, { type: 'physical-step-complete' }>;

interface PhysicalTask {
  readonly step: IndexerPhysicalStep;
  readonly lane: PhysicalLane;
  resolve(result: PhysicalStepResult): void;
  reject(error: Error): void;
}

interface LogicalWaiter {
  resolve(): void;
  reject(error: Error): void;
}

export class TranscriptSearchService {
  readonly #searchDirectory: string;
  readonly #dbPath: string;
  readonly #indexer: SearchWorkerSupervisor<IndexerRequest, IndexerEvent>;
  readonly #reader: SearchWorkerSupervisor<ReaderRequest, ReaderEvent>;
  readonly #physicalStepTimeoutMs: number;
  readonly #logicalWaiters: LogicalWaiter[] = [];
  readonly #livePhysicalQueue: PhysicalTask[] = [];
  readonly #cleanupPhysicalQueue: PhysicalTask[] = [];
  readonly #reservations = new Map<number, number>();
  readonly #operations = new Set<Promise<unknown>>();
  #logicalActive = 0;
  #writeAdmissionOpen = true;
  #logicalIdleResolve: (() => void) | null = null;
  #physicalDispatchActive = false;
  #consecutiveLiveGrants = 0;
  #nextGrantId = 0;
  #nextReaderGrantId = 0;
  #walEpoch = 0;
  #observedWal: WalObservation | null = null;
  #walAuthorityFenced = true;
  #maintenancePending = false;
  #workersReady = false;
  #searchFenced = true;
  #barrierPromise: Promise<void> | null = null;
  #recoveryPromise: Promise<void> | null = null;
  #recoveryRequested = false;
  #recoveryRecreate = false;
  #recoveryResyncActive = false;
  #searchTail: Promise<void> = Promise.resolve();
  #enabled = false;
  #closed = false;
  #resyncHandler: (() => void | Promise<void>) | null = null;

  constructor(options: TranscriptSearchServiceOptions) {
    this.#searchDirectory = path.join(options.workspaceDirectory, SEARCH_DIRECTORY);
    this.#dbPath = path.join(this.#searchDirectory, 'index.sqlite');
    this.#physicalStepTimeoutMs = options.indexWriteTimeoutMs
      ?? SEARCH_WORKER_PHYSICAL_STEP_TIMEOUT_MS;
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
      onEvent: () => {},
      onFault: (error) => this.#onWorkerFault(error),
    });
    this.#reader = new SearchWorkerSupervisor({
      role: 'reader',
      moduleUrl: entrypoints.reader,
      logger: options.logger,
      workerFactory: options.workerFactory,
      createRequest: (input, envelope) => ({ ...input, ...envelope }),
      isEvent: isReaderEvent,
      eventError: workerEventError,
      onEvent: () => {},
      onFault: (error) => this.#onWorkerFault(error),
    });
  }

  setResyncHandler(handler: () => void | Promise<void>): void {
    this.#resyncHandler = handler;
  }

  async enable(signal: AbortSignal): Promise<void> {
    if (this.#closed) throw new Error('Transcript search service is closed');
    if (this.#enabled) return;
    signal.throwIfAborted();
    await fs.mkdir(this.#searchDirectory, { recursive: true, mode: 0o700 });
    this.#writeAdmissionOpen = true;
    this.#maintenancePending = false;
    this.#reservations.clear();
    this.#observedWal = null;
    this.#walAuthorityFenced = true;
    this.#searchFenced = true;
    this.#workersReady = false;
    try {
      await this.#startFreshWorkerPair(signal, false);
      this.#enabled = true;
      this.#searchFenced = false;
      this.#workersReady = true;
      this.#pumpPhysicalQueue();
    } catch (error) {
      await this.#stopWorkers();
      throw error;
    }
  }

  replaceChat(input: Omit<TranscriptSearchIndexInput, 'expectedAfterOrdinal'>): Promise<void> {
    return this.#trackOperation(this.#runLogical(() => this.#indexChat('replace', {
      ...input,
      expectedAfterOrdinal: 0,
    })));
  }

  appendRows(input: TranscriptSearchIndexInput): Promise<void> {
    return this.#trackOperation(this.#runLogical(() => this.#indexChat('append', input)));
  }

  deleteChat(chatId: string): Promise<void> {
    return this.#trackOperation(this.#runLogical(() => this.#removeChat(chatId)));
  }

  pruneChats(
    snapshotAllowedChatIds: () => readonly string[],
    beforeWriteAdmissionReopens: (cleanups: readonly PrunedChatCleanup[]) => void,
  ): Promise<void> {
    const operation = this.#pruneChats(snapshotAllowedChatIds, beforeWriteAdmissionReopens);
    return this.#trackOperation(operation);
  }

  finishPrunedChatCleanup(cleanup: PrunedChatCleanup): Promise<void> {
    if (!this.#enabled || this.#closed) return Promise.resolve();
    return this.#trackOperation(this.#finishPrunedChatCleanup(cleanup));
  }

  search(request: {
    readonly query: ChatSearchQueryV1;
    readonly allowedChats: readonly TranscriptSearchAllowedChat[];
    readonly limit: number;
    readonly signal: AbortSignal;
  }): Promise<{ readonly results: readonly ChatSearchResult[]; readonly index: ChatSearchIndexStatus }> {
    const prior = this.#searchTail;
    const result = prior.catch(() => undefined).then(() => this.#search(request));
    this.#searchTail = result.then(() => undefined, () => undefined);
    return result;
  }

  async disableAndDelete(signal: AbortSignal): Promise<void> {
    this.#enabled = false;
    this.#searchFenced = true;
    this.#workersReady = false;
    this.#writeAdmissionOpen = false;
    this.#rejectLogicalWaiters(new Error('SEARCH_INDEX_UNAVAILABLE'));
    this.#rejectQueuedPhysical(new Error('SEARCH_INDEX_UNAVAILABLE'));
    await this.#drainOperations();
    await this.#cooperativeCloseWorkers();
    signal.throwIfAborted();
    await fs.rm(this.#searchDirectory, { recursive: true, force: true });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#enabled = false;
    this.#searchFenced = true;
    this.#workersReady = false;
    this.#writeAdmissionOpen = false;
    this.#rejectLogicalWaiters(new Error('SEARCH_INDEX_UNAVAILABLE'));
    this.#rejectQueuedPhysical(new Error('SEARCH_INDEX_UNAVAILABLE'));
    await this.#drainOperations();
    await this.#stopWorkers();
  }

  async #indexChat(
    mode: 'replace' | 'append',
    input: TranscriptSearchIndexInput,
  ): Promise<void> {
    requireIndexInput(input);
    let expectedState: SearchChatState | null = null;
    let nextRowIndex = 0;
    try {
      let result = await this.#enqueuePhysical(mode === 'replace'
        ? {
            kind: 'plan-replacement',
            chatId: input.chatId,
            transcriptViewId: input.transcriptViewId,
            targetThrough: input.throughOrdinal,
          }
        : {
            kind: 'plan-append',
            chatId: input.chatId,
            transcriptViewId: input.transcriptViewId,
            expectedAfterOrdinal: input.expectedAfterOrdinal,
            targetThrough: input.throughOrdinal,
          }, 'live');

      while (true) {
        if (result.kind === 'mutation-superseded') return;
        if (result.kind === 'sync-plan' && result.disposition === 'current') return;
        if ('state' in result) expectedState = result.state;

        if (isReplacementCheckpointResult(result)) {
          result = await this.#enqueuePhysical({
            kind: 'complete-replacement-checkpoint',
            expectedState: result.state,
          }, 'cleanup');
          continue;
        }

        const state = resultState(result);
        if (state.status === 'indexed' && state.phase === 'idle') return;
        if (state.phase === 'replacement-cleanup' || state.phase === 'removal-cleanup') {
          result = await this.#enqueuePhysical({ kind: 'cleanup', expectedState: state }, 'cleanup');
          continue;
        }
        if (state.activeChunkId !== null) {
          result = await this.#enqueuePhysical({ kind: 'build-terms', expectedState: state }, 'live');
          continue;
        }
        if (state.processedThrough === state.targetThrough) {
          result = await this.#enqueuePhysical({ kind: 'activate', expectedState: state }, 'live');
          continue;
        }
        while (input.rows[nextRowIndex]?.ordinal <= state.processedThrough) nextRowIndex += 1;
        const nextRow = input.rows[nextRowIndex];
        if (!nextRow || nextRow.ordinal > state.targetThrough) {
          result = await this.#enqueuePhysical({
            kind: 'advance-frontier',
            expectedState: state,
            throughOrdinal: state.targetThrough,
          }, 'live');
          continue;
        }
        const rows = this.#selectRawStageRows(state, input.rows.slice(nextRowIndex));
        result = await this.#enqueuePhysical({ kind: 'stage-raw', expectedState: state, rows }, 'live');
      }
    } catch (error) {
      const errorCode = recordableBuildFailureCode(error);
      if (expectedState && errorCode !== null
          && expectedState.status === 'pending'
          && (expectedState.phase === 'append-build'
            || expectedState.phase === 'replacement-build')) {
        await this.#enqueuePhysical({
          kind: 'mark-failed',
          expectedState,
          errorCode,
        }, 'live').catch(() => undefined);
      }
      throw error;
    }
  }

  async #removeChat(chatId: string): Promise<void> {
    let result = await this.#enqueuePhysical({ kind: 'start-removal', chatId }, 'cleanup');
    while (true) {
      if (result.kind === 'chat-deleted' || result.kind === 'mutation-superseded') return;
      const state = resultState(result);
      result = await this.#enqueuePhysical({ kind: 'cleanup', expectedState: state }, 'cleanup');
    }
  }

  async #pruneChats(
    snapshotAllowedChatIds: () => readonly string[],
    beforeWriteAdmissionReopens: (cleanups: readonly PrunedChatCleanup[]) => void,
  ): Promise<void> {
    if (!this.#enabled || this.#closed) return;
    this.#writeAdmissionOpen = false;
    await this.#waitForLogicalIdle();
    if (!this.#enabled || this.#closed) return;
    const allowedChatIds = [...new Set(snapshotAllowedChatIds())].sort();
    const cleanups: PrunedChatCleanup[] = [];
    let completed = false;
    try {
      let afterChatId: string | null = null;
      while (true) {
        const result = await this.#enqueuePhysical({
          kind: 'prune-mark',
          allowedChatIds,
          afterChatId,
        }, 'cleanup');
        if (result.kind === 'mutation-superseded') continue;
        if (result.kind !== 'prune-progress') throw new Error('SEARCH_INDEX_INVALID_RESPONSE');
        cleanups.push(...result.cleanups);
        if (result.done) {
          completed = true;
          break;
        }
        if (result.nextAfterChatId === null || result.nextAfterChatId === afterChatId) {
          throw new Error('SEARCH_INDEX_INVALID_RESPONSE');
        }
        afterChatId = result.nextAfterChatId;
      }
    } finally {
      if (this.#enabled && !this.#closed) {
        if (completed || cleanups.length > 0) beforeWriteAdmissionReopens(cleanups);
        this.#writeAdmissionOpen = true;
        this.#pumpLogicalWaiters();
      }
    }
  }

  async #finishPrunedChatCleanup(cleanup: PrunedChatCleanup): Promise<void> {
    let state = cleanup.expectedState;
    while (true) {
      const result = await this.#enqueuePhysical({ kind: 'cleanup', expectedState: state }, 'cleanup');
      if (result.kind === 'chat-deleted' || result.kind === 'mutation-superseded') return;
      if (result.kind !== 'cleanup-progress') throw new Error('SEARCH_INDEX_INVALID_RESPONSE');
      state = result.state;
    }
  }

  async #search(request: {
    readonly query: ChatSearchQueryV1;
    readonly allowedChats: readonly TranscriptSearchAllowedChat[];
    readonly limit: number;
    readonly signal: AbortSignal;
  }): Promise<{ readonly results: readonly ChatSearchResult[]; readonly index: ChatSearchIndexStatus }> {
    request.signal.throwIfAborted();
    const barrier = this.#barrierPromise;
    if (barrier) await waitForPromiseWithSignal(barrier, request.signal);
    if (!this.#enabled || this.#closed || this.#searchFenced || !this.#reader.available) {
      throw new Error('SEARCH_INDEX_UNAVAILABLE');
    }
    const session = this.#reader.beginRequestSession();
    try {
      const start = { type: 'search-start' as const, query: request.query, limit: request.limit };
      this.#requireReaderEnvelope(session, start);
      const startAck = await session.request([start], request.signal, SEARCH_TIMEOUT_MS, {
        isComplete: (event) => event.type === 'search-input-ack',
        matches: (event) => event.type === 'error'
          ? event.grantId === null
          : event.type === 'search-input-ack'
            && event.chunkIndex === null
            && event.ready === false,
      });
      if (startAck.type !== 'search-input-ack') throw new Error('SEARCH_INDEX_INVALID_RESPONSE');

      let allowlistOffset = 0;
      let allowlistChunkIndex = 0;
      do {
        const frame = this.#nextAllowlistFrame(
          session,
          request.allowedChats,
          allowlistOffset,
          allowlistChunkIndex,
        );
        const ack = await session.request([frame], request.signal, SEARCH_TIMEOUT_MS, {
          isComplete: (event) => event.type === 'search-input-ack',
          matches: (event) => event.type === 'error'
            ? event.grantId === null
            : event.type === 'search-input-ack'
              && event.chunkIndex === frame.chunkIndex
              && event.ready === frame.done,
        });
        if (ack.type !== 'search-input-ack') throw new Error('SEARCH_INDEX_INVALID_RESPONSE');
        allowlistOffset += frame.allowedChats.length;
        allowlistChunkIndex += 1;
      } while (allowlistOffset < request.allowedChats.length);

      const results: ChatSearchResult[] = [];
      let expectedChunkIndex = 0;
      let index: ChatSearchIndexStatus | null = null;
      while (index === null) {
        const grantId = this.#nextReaderGrant();
        const grant = { type: 'reader-step-grant' as const, grantId };
        this.#requireReaderEnvelope(session, grant);
        const event = await session.request([grant], request.signal, SEARCH_TIMEOUT_MS, {
          isComplete: (candidate) => candidate.type === 'reader-step-complete',
          matches: (candidate) => candidate.type === 'error'
            ? candidate.grantId === grantId
            : candidate.type === 'reader-step-complete'
              && candidate.grantId === grantId,
        });
        if (event.type !== 'reader-step-complete') throw new Error('SEARCH_INDEX_INVALID_RESPONSE');
        if (event.result.kind === 'continue') continue;
        if (event.result.chunkIndex !== expectedChunkIndex) {
          throw new Error('SEARCH_INDEX_INVALID_RESPONSE');
        }
        expectedChunkIndex += 1;
        results.push(...event.result.results);
        if (event.result.done) index = event.result.index;
      }
      const allowed = new Map(
        request.allowedChats.map((entry) => [entry.chatId, entry.transcriptViewId]),
      );
      if (results.some((result) => allowed.get(result.chatId) !== result.transcriptViewId)) {
        throw new Error('SEARCH_INDEX_INVALID_RESPONSE');
      }
      return { results, index };
    } catch (error) {
      const barrier = this.#barrierPromise;
      if (barrier) {
        await waitForPromiseWithSignal(barrier, request.signal);
        return this.#search(request);
      }
      if (error instanceof TranscriptSearchWorkerError) {
        if (error.retryable) {
          await this.#beginUnknownRecovery(error, error.code === 'SEARCH_INDEX_CORRUPT');
        }
      } else if (this.#recoveryPromise) {
        await this.#recoveryPromise;
      }
      throw error;
    }
  }

  #selectRawStageRows(
    state: SearchChatState,
    candidates: readonly HistoricalSearchMessageRow[],
  ): readonly HistoricalSearchMessageRow[] {
    const rows: HistoricalSearchMessageRow[] = [];
    let bodyBytes = 0;
    for (const row of candidates) {
      if (rows.length === SEARCH_RAW_STAGE_MAX_ROWS) break;
      const nextBodyBytes = bodyBytes + Buffer.byteLength(row.body, 'utf8');
      if (nextBodyBytes > SEARCH_RAW_STAGE_MAX_BYTES) break;
      const nextRows = [...rows, row];
      if (!this.#indexerEnvelopeWithinLimit({ kind: 'stage-raw', expectedState: state, rows: nextRows })) {
        break;
      }
      rows.push(row);
      bodyBytes = nextBodyBytes;
    }
    if (rows.length === 0) throw new Error('SEARCH_WORKER_ENVELOPE_LIMIT');
    return rows;
  }

  #nextAllowlistFrame(
    session: SearchWorkerRequestSession<WorkerRequestInput<ReaderRequest>, ReaderEvent>,
    allowedChats: readonly TranscriptSearchAllowedChat[],
    offset: number,
    chunkIndex: number,
  ): Extract<WorkerRequestInput<ReaderRequest>, { type: 'search-allowlist-chunk' }> {
    const chunk: TranscriptSearchAllowedChat[] = [];
    while (offset + chunk.length < allowedChats.length
        && chunk.length < SEARCH_READER_MAX_ALLOWLIST_ROWS) {
      chunk.push(allowedChats[offset + chunk.length]!);
      const frame = {
        type: 'search-allowlist-chunk' as const,
        chunkIndex,
        allowedChats: chunk,
        done: offset + chunk.length === allowedChats.length,
      };
      if (!this.#readerEnvelopeWithinLimit(session, frame)) {
        chunk.pop();
        break;
      }
    }
    if (allowedChats.length > 0 && chunk.length === 0) {
      throw new Error('SEARCH_ALLOWLIST_TOO_LARGE');
    }
    const frame = {
      type: 'search-allowlist-chunk' as const,
      chunkIndex,
      allowedChats: chunk,
      done: offset + chunk.length === allowedChats.length,
    };
    this.#requireReaderEnvelope(session, frame);
    return frame;
  }

  #enqueuePhysical(step: IndexerPhysicalStep, lane: PhysicalLane): Promise<PhysicalStepResult> {
    if (!this.#enabled || this.#closed
        || (!this.#workersReady && this.#barrierPromise === null)) {
      return Promise.reject(new Error('SEARCH_INDEX_UNAVAILABLE'));
    }
    return new Promise<PhysicalStepResult>((resolve, reject) => {
      const task = { step, lane, resolve, reject };
      if (lane === 'cleanup') this.#cleanupPhysicalQueue.push(task);
      else this.#livePhysicalQueue.push(task);
      this.#pumpPhysicalQueue();
    });
  }

  #pumpPhysicalQueue(): void {
    if (this.#physicalDispatchActive || !this.#workersReady || this.#maintenancePending
        || this.#walAuthorityFenced || this.#closed) return;
    const task = this.#nextPhysicalTask();
    if (!task) return;
    this.#physicalDispatchActive = true;
    void this.#executePhysicalTask(task).then(task.resolve, task.reject).finally(() => {
      this.#physicalDispatchActive = false;
      queueMicrotask(() => this.#pumpPhysicalQueue());
    });
  }

  #nextPhysicalTask(): PhysicalTask | null {
    if (this.#cleanupPhysicalQueue.length > 0
        && (this.#livePhysicalQueue.length === 0
          || this.#consecutiveLiveGrants >= MAX_CONSECUTIVE_LIVE_GRANTS)) {
      this.#consecutiveLiveGrants = 0;
      return this.#cleanupPhysicalQueue.shift() ?? null;
    }
    const live = this.#livePhysicalQueue.shift();
    if (live) {
      this.#consecutiveLiveGrants += 1;
      return live;
    }
    const cleanup = this.#cleanupPhysicalQueue.shift() ?? null;
    if (cleanup) this.#consecutiveLiveGrants = 0;
    return cleanup;
  }

  async #executePhysicalTask(task: PhysicalTask): Promise<PhysicalStepResult> {
    if (!this.#canReserveNextGrant()) await this.#ensureKnownBarrier();
    if (!this.#canReserveNextGrant()) throw new Error('SEARCH_WAL_MAINTENANCE_REQUIRED');
    const grantId = this.#nextGrant();
    this.#reservations.set(grantId, SEARCH_MAX_DIRTY_FRAMES);
    const walEpoch = this.#walEpoch;
    const request = {
      type: 'physical-step-grant' as const,
      grantId,
      walEpoch,
      step: task.step,
    };
    if (!this.#indexerEnvelopeWithinLimit(task.step, grantId)) {
      this.#reservations.delete(grantId);
      throw new Error('SEARCH_WORKER_ENVELOPE_LIMIT');
    }
    try {
      const event = await this.#indexer.request([request], undefined, {
        startTimeoutMs: SEARCH_WORKER_STEP_START_TIMEOUT_MS,
        physicalTimeoutMs: this.#physicalStepTimeoutMs,
        isStarted: (candidate) => candidate.type === 'step-started',
        isComplete: (candidate) => candidate.type === 'physical-step-complete',
        matches: (candidate) => grantMatches(candidate, grantId),
      });
      if (event.type !== 'physical-step-complete') throw new Error('SEARCH_INDEX_INVALID_RESPONSE');
      this.#acceptKnownCompletion(event, walEpoch);
      if (!event.wal || physicalStepResultRequiresSecureBarrier(event.result)) {
        await this.#ensureKnownBarrier();
      }
      return event.result;
    } catch (error) {
      if (isKnownIndexerGrantError(error, grantId)) {
        try {
          this.#acceptKnownGrant(grantId, error.wal, walEpoch);
        } catch (observationError) {
          if (!this.#recoveryPromise) {
            void this.#beginUnknownRecovery(asError(observationError), false)
              .catch(() => undefined);
          }
          throw observationError;
        }
        if (error.code === 'SEARCH_INDEX_CORRUPT') {
          void this.#beginUnknownRecovery(error, true).catch(() => undefined);
          throw error;
        }
        if (!error.wal || error.code === 'SEARCH_WAL_MAINTENANCE_REQUIRED') {
          await this.#ensureKnownBarrier();
        }
        if (error.code === 'SEARCH_WAL_MAINTENANCE_REQUIRED') {
          return this.#executePhysicalTask(task);
        }
        throw error;
      }
      if (!this.#recoveryPromise) {
        void this.#beginUnknownRecovery(asError(error), false).catch(() => undefined);
      }
      throw error;
    }
  }

  #acceptKnownCompletion(event: IndexerCompleteEvent, expectedWalEpoch: number): void {
    this.#acceptKnownGrant(event.grantId, event.wal, expectedWalEpoch);
  }

  #acceptKnownGrant(
    grantId: number,
    wal: WalObservation | undefined,
    expectedWalEpoch: number,
  ): void {
    if (!this.#reservations.has(grantId)) {
      throw new Error('SEARCH_WAL_RESERVATION_MISMATCH');
    }
    if (wal && (wal.walEpoch !== expectedWalEpoch || wal.walEpoch !== this.#walEpoch)) {
      this.#walAuthorityFenced = true;
      throw new Error('SEARCH_WAL_OBSERVATION_INVALID');
    }
    if (wal && (!this.#observedWal || isNewerWalObservation(wal, this.#observedWal))) {
      this.#observedWal = wal;
    }
    this.#reservations.delete(grantId);
    if (!wal) this.#walAuthorityFenced = true;
  }

  #canReserveNextGrant(): boolean {
    const observation = this.#observedWal;
    if (this.#walAuthorityFenced || !observation || observation.walEpoch !== this.#walEpoch) {
      return false;
    }
    const reserved = [...this.#reservations.values()].reduce((sum, frames) => sum + frames, 0);
    const backlog = observation.logFrames - observation.checkpointedFrames;
    return observation.logFrames + reserved + SEARCH_MAX_DIRTY_FRAMES
      <= SEARCH_WAL_HIGH_WATER_FRAMES
      && backlog + reserved + SEARCH_MAX_DIRTY_FRAMES <= SEARCH_WAL_HIGH_WATER_FRAMES;
  }

  #ensureKnownBarrier(): Promise<void> {
    if (this.#barrierPromise) return this.#barrierPromise;
    this.#maintenancePending = true;
    this.#searchFenced = true;
    this.#workersReady = false;
    const barrier = this.#runMaintenanceBarrier(false).finally(() => {
      if (this.#barrierPromise === barrier) this.#barrierPromise = null;
    });
    this.#barrierPromise = barrier;
    return barrier;
  }

  async #runMaintenanceBarrier(recreate: boolean): Promise<void> {
    await this.#cooperativeCloseWorkers();
    if (recreate) await this.#removeDatabaseFiles();
    this.#reservations.clear();
    this.#observedWal = null;
    this.#walAuthorityFenced = true;
    await this.#startFreshWorkerPair(new AbortController().signal, false);
    this.#maintenancePending = false;
    this.#workersReady = true;
    this.#searchFenced = !this.#enabled;
    this.#pumpPhysicalQueue();
  }

  #onWorkerFault(error: Error): void {
    if (!this.#enabled || this.#closed) return;
    this.#searchFenced = true;
    this.#workersReady = false;
    this.#walAuthorityFenced = true;
    void this.#beginUnknownRecovery(error, false).catch(() => undefined);
  }

  #beginUnknownRecovery(error: Error, recreate: boolean): Promise<void> {
    if (this.#recoveryPromise) {
      this.#recoveryRequested = true;
      this.#recoveryRecreate ||= recreate;
      this.#rejectQueuedPhysical(error);
      this.#rejectLogicalWaiters(error);
      return this.#recoveryResyncActive ? Promise.resolve() : this.#recoveryPromise;
    }
    this.#maintenancePending = true;
    this.#searchFenced = true;
    this.#workersReady = false;
    this.#walAuthorityFenced = true;
    this.#rejectQueuedPhysical(error);
    this.#rejectLogicalWaiters(error);
    const recovery = (async () => {
      this.#recoveryRecreate = recreate;
      do {
        this.#recoveryRequested = false;
        await this.#cooperativeCloseWorkers();
        if (this.#recoveryRecreate) await this.#removeDatabaseFiles();
        this.#recoveryRecreate = false;
        this.#reservations.clear();
        this.#observedWal = null;
        await this.#startFreshWorkerPair(new AbortController().signal, false);
        this.#maintenancePending = false;
        this.#workersReady = true;
        this.#searchFenced = !this.#enabled;
        this.#walAuthorityFenced = false;
        this.#pumpPhysicalQueue();
        this.#pumpLogicalWaiters();
        this.#recoveryResyncActive = true;
        try {
          await this.#resyncHandler?.();
        } catch (error) {
          if (!this.#recoveryRequested) throw error;
        } finally {
          this.#recoveryResyncActive = false;
        }
      } while (this.#recoveryRequested);
    })().finally(() => {
      if (this.#recoveryPromise === recovery) this.#recoveryPromise = null;
    });
    this.#recoveryPromise = recovery;
    return recovery;
  }

  async #startFreshWorkerPair(signal: AbortSignal, recreate: boolean): Promise<void> {
    if (recreate) await this.#removeDatabaseFiles();
    const maintenanceEpoch = this.#nextWalLifecycleEpoch();
    await this.#startIndexer(signal, maintenanceEpoch);
    await this.#checkpointIndexer(signal, maintenanceEpoch);
    await this.#indexer.cooperativeClose({ type: 'indexer-quiesce' }, WORKER_CLOSE_TIMEOUT_MS);

    const writerEpoch = this.#nextWalLifecycleEpoch();
    await this.#startIndexer(signal, writerEpoch);
    await this.#startReader(signal);
    this.#walAuthorityFenced = false;
  }

  async #startIndexer(signal: AbortSignal, walEpoch: number): Promise<void> {
    await this.#indexer.start(signal, async (admissionSignal) => {
      const event = await this.#indexer.request(
        [{ type: 'open', dbPath: this.#dbPath, walEpoch }],
        admissionSignal,
        REQUEST_TIMEOUT_MS,
      );
      if (event.type !== 'opened' || event.wal.walEpoch !== walEpoch) {
        throw new Error('Transcript indexer admission failed');
      }
      this.#walEpoch = walEpoch;
      this.#observedWal = event.wal;
      this.#walAuthorityFenced = false;
    });
  }

  async #startReader(signal: AbortSignal): Promise<void> {
    await this.#reader.start(signal, async (admissionSignal) => {
      const event = await this.#reader.request(
        [{ type: 'open', dbPath: this.#dbPath }],
        admissionSignal,
        REQUEST_TIMEOUT_MS,
      );
      if (event.type !== 'opened') throw new Error('Transcript reader admission failed');
    });
  }

  async #checkpointIndexer(signal: AbortSignal, walEpoch: number): Promise<void> {
    const event = await this.#indexer.request(
      [{ type: 'checkpoint', mode: 'TRUNCATE', walEpoch }],
      signal,
      REQUEST_TIMEOUT_MS,
    );
    if (event.type !== 'checkpoint-complete'
        || event.busy !== 0
        || event.logFrames !== 0
        || event.checkpointedFrames !== 0
        || event.wal.walEpoch !== walEpoch
        || event.wal.logFrames !== 0
        || event.wal.checkpointedFrames !== 0) {
      throw new Error('SEARCH_WAL_CHECKPOINT_INCOMPLETE');
    }
    this.#observedWal = event.wal;
  }

  async #cooperativeCloseWorkers(): Promise<void> {
    const results = await Promise.allSettled([
      this.#reader.cooperativeClose({ type: 'reader-quiesce' }, WORKER_CLOSE_TIMEOUT_MS),
      this.#indexer.cooperativeClose({ type: 'indexer-quiesce' }, WORKER_CLOSE_TIMEOUT_MS),
    ]);
    const rejected = results.find((result): result is PromiseRejectedResult => (
      result.status === 'rejected'
    ));
    if (rejected) throw rejected.reason;
  }

  async #stopWorkers(): Promise<void> {
    await Promise.all([
      this.#reader.stop({ type: 'reader-quiesce' }, WORKER_CLOSE_TIMEOUT_MS),
      this.#indexer.stop({ type: 'indexer-quiesce' }, WORKER_CLOSE_TIMEOUT_MS),
    ]);
  }

  async #removeDatabaseFiles(): Promise<void> {
    await Promise.all([
      fs.rm(this.#dbPath, { force: true }),
      fs.rm(`${this.#dbPath}-wal`, { force: true }),
      fs.rm(`${this.#dbPath}-shm`, { force: true }),
    ]);
  }

  async #runLogical(work: () => Promise<void>): Promise<void> {
    if (!this.#enabled || this.#closed) return;
    await this.#acquireLogicalPermit();
    try {
      if (!this.#enabled || this.#closed) return;
      await work();
    } finally {
      this.#releaseLogicalPermit();
    }
  }

  #acquireLogicalPermit(): Promise<void> {
    if (this.#writeAdmissionOpen && this.#logicalActive < 2) {
      this.#logicalActive += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      this.#logicalWaiters.push({ resolve, reject });
    });
  }

  #releaseLogicalPermit(): void {
    this.#logicalActive -= 1;
    if (this.#logicalActive < 0) throw new Error('SEARCH_LOGICAL_PERMIT_INVARIANT');
    if (this.#logicalActive === 0) {
      this.#logicalIdleResolve?.();
      this.#logicalIdleResolve = null;
    }
    this.#pumpLogicalWaiters();
  }

  #pumpLogicalWaiters(): void {
    while (this.#writeAdmissionOpen && this.#logicalActive < 2 && this.#logicalWaiters.length > 0
        && this.#enabled && !this.#closed) {
      this.#logicalActive += 1;
      this.#logicalWaiters.shift()!.resolve();
    }
  }

  #waitForLogicalIdle(): Promise<void> {
    if (this.#logicalActive === 0) return Promise.resolve();
    return new Promise<void>((resolve) => { this.#logicalIdleResolve = resolve; });
  }

  #rejectLogicalWaiters(error: Error): void {
    for (const waiter of this.#logicalWaiters.splice(0)) waiter.reject(error);
  }

  #rejectQueuedPhysical(error: Error): void {
    for (const task of this.#livePhysicalQueue.splice(0)) task.reject(error);
    for (const task of this.#cleanupPhysicalQueue.splice(0)) task.reject(error);
  }

  #trackOperation<T>(operation: Promise<T>): Promise<T> {
    this.#operations.add(operation);
    const remove = () => this.#operations.delete(operation);
    void operation.then(remove, remove);
    return operation;
  }

  async #drainOperations(): Promise<void> {
    await Promise.allSettled([...this.#operations]);
  }

  #nextGrant(): number {
    this.#nextGrantId += 1;
    if (!Number.isSafeInteger(this.#nextGrantId) || this.#nextGrantId <= 0) {
      throw new Error('SEARCH_GRANT_ID_EXHAUSTED');
    }
    return this.#nextGrantId;
  }

  #nextReaderGrant(): number {
    this.#nextReaderGrantId += 1;
    if (!Number.isSafeInteger(this.#nextReaderGrantId) || this.#nextReaderGrantId <= 0) {
      throw new Error('SEARCH_GRANT_ID_EXHAUSTED');
    }
    return this.#nextReaderGrantId;
  }

  #nextWalLifecycleEpoch(): number {
    this.#walEpoch += 1;
    if (!Number.isSafeInteger(this.#walEpoch) || this.#walEpoch <= 0) {
      throw new Error('SEARCH_WAL_EPOCH_EXHAUSTED');
    }
    return this.#walEpoch;
  }

  #indexerEnvelopeWithinLimit(step: IndexerPhysicalStep, grantId = Number.MAX_SAFE_INTEGER): boolean {
    return workerEnvelopeWithinLimit({
      type: 'physical-step-grant',
      requestId: Number.MAX_SAFE_INTEGER,
      lifecycleEpoch: this.#indexer.epoch,
      grantId,
      walEpoch: this.#walEpoch,
      step,
    });
  }

  #readerEnvelopeWithinLimit(
    session: SearchWorkerRequestSession<WorkerRequestInput<ReaderRequest>, ReaderEvent>,
    input: WorkerRequestInput<ReaderRequest>,
  ): boolean {
    return workerEnvelopeWithinLimit({
      ...input,
      requestId: session.requestId,
      lifecycleEpoch: this.#reader.epoch,
    });
  }

  #requireReaderEnvelope(
    session: SearchWorkerRequestSession<WorkerRequestInput<ReaderRequest>, ReaderEvent>,
    input: WorkerRequestInput<ReaderRequest>,
  ): void {
    if (!this.#readerEnvelopeWithinLimit(session, input)) {
      throw new Error('SEARCH_WORKER_ENVELOPE_LIMIT');
    }
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function waitForPromiseWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let onAbort: (() => void) | null = null;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([promise, aborted]).finally(() => {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  });
}
