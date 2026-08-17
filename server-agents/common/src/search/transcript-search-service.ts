import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  ChatSearchIndexStatus,
  ChatSearchQueryV1,
  ChatSearchResult,
  TranscriptSearchAllowedChat,
} from '@garcon/common/chat-search';
import type { AgentLogger } from '@garcon/server-agent-interface';
import {
  resolveSearchWorkerEntrypoints,
} from '../build/standalone-entrypoint.js';
import type { HistoricalSearchMessageRow } from './rows.js';
import type {
  IndexerEvent,
  IndexerRequest,
  ReaderEvent,
  ReaderRequest,
} from './worker-protocol.js';
import { isIndexerEvent, isReaderEvent } from './worker-protocol.js';
import {
  SearchWorkerSupervisor,
  type WorkerRequestInput,
} from './worker-supervisor.js';

const SEARCH_DIRECTORY = 'transcript-search';
const REQUEST_TIMEOUT_MS = 30_000;
const SEARCH_TIMEOUT_MS = 5_000;
const WORKER_CLOSE_TIMEOUT_MS = 5_000;
const MAX_ROWS_PER_FRAME = 250;
const MAX_ALLOWLIST_PER_FRAME = 2_000;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;

export interface TranscriptSearchServiceOptions {
  readonly workspaceDirectory: string;
  readonly logger: AgentLogger;
  readonly workerFactory?: (role: 'indexer' | 'reader', moduleUrl: string) => Worker;
}

export interface TranscriptSearchIndexInput {
  readonly chatId: string;
  readonly transcriptViewId: string;
  readonly expectedAfterOrdinal: number;
  readonly throughOrdinal: number;
  readonly rows: readonly HistoricalSearchMessageRow[];
}

export class TranscriptSearchService {
  readonly #searchDirectory: string;
  readonly #dbPath: string;
  readonly #indexer: SearchWorkerSupervisor<IndexerRequest, IndexerEvent>;
  readonly #reader: SearchWorkerSupervisor<ReaderRequest, ReaderEvent>;
  readonly #inFlightWrites = new Set<Promise<void>>();
  #admissionGate: Promise<void> = Promise.resolve();
  #enabled = false;
  #closed = false;
  #resyncHandler: (() => void | Promise<void>) | null = null;

  constructor(options: TranscriptSearchServiceOptions) {
    this.#searchDirectory = path.join(options.workspaceDirectory, SEARCH_DIRECTORY);
    this.#dbPath = path.join(this.#searchDirectory, 'index.sqlite');
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
      shouldRestart: () => this.#enabled && !this.#closed,
      admit: async (signal) => {
        const event = await this.#requestIndexer({ type: 'open', dbPath: this.#dbPath }, signal);
        if (event.type !== 'opened') throw new Error('Transcript indexer admission failed');
      },
      afterRestart: async () => this.#resyncHandler?.(),
      onEvent: () => {},
      onCrash: () => {},
    });
    this.#reader = new SearchWorkerSupervisor({
      role: 'reader',
      moduleUrl: entrypoints.reader,
      logger: options.logger,
      workerFactory: options.workerFactory,
      createRequest: (input, envelope) => ({ ...input, ...envelope }),
      isEvent: isReaderEvent,
      eventError: workerEventError,
      shouldRestart: () => this.#enabled && !this.#closed,
      admit: async (signal) => {
        const event = await this.#requestReader({ type: 'open', dbPath: this.#dbPath }, signal);
        if (event.type !== 'opened') throw new Error('Transcript reader admission failed');
      },
      onEvent: () => {},
      onCrash: () => {},
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
    try {
      await this.#indexer.start(signal);
      await this.#reader.start(signal);
      this.#enabled = true;
    } catch (error) {
      await this.#stopWorkers();
      throw error;
    }
  }

  replaceChat(input: Omit<TranscriptSearchIndexInput, 'expectedAfterOrdinal'>): Promise<void> {
    return this.#trackWrite(async () => {
      await this.#requestIndexerFrames(indexFrames('replace', {
        ...input,
        expectedAfterOrdinal: 0,
      }));
    });
  }

  appendRows(input: TranscriptSearchIndexInput): Promise<void> {
    return this.#trackWrite(async () => {
      await this.#requestIndexerFrames(indexFrames('append', input));
    });
  }

  deleteChat(chatId: string): Promise<void> {
    return this.#trackWrite(async () => {
      await this.#requestIndexer({ type: 'delete-chat', chatId });
    });
  }

  pruneChats(chatIds: readonly string[]): Promise<void> {
    return this.#runExclusiveWrite(async () => {
      await this.#requestIndexer({ type: 'prune-chats', chatIds });
    });
  }

  async search(request: {
    readonly query: ChatSearchQueryV1;
    readonly allowedChats: readonly TranscriptSearchAllowedChat[];
    readonly limit: number;
    readonly signal: AbortSignal;
  }): Promise<{ readonly results: readonly ChatSearchResult[]; readonly index: ChatSearchIndexStatus }> {
    if (!this.#enabled || this.#closed || !this.#reader.available) {
      throw new Error('SEARCH_INDEX_UNAVAILABLE');
    }
    const event = await this.#reader.request(
      searchFrames(request.query, request.allowedChats, request.limit),
      request.signal,
      SEARCH_TIMEOUT_MS,
    );
    if (event.type !== 'search-result') throw new Error('SEARCH_INDEX_UNAVAILABLE');
    const allowed = new Map(
      request.allowedChats.map((entry) => [entry.chatId, entry.transcriptViewId]),
    );
    if (event.results.some(
      (result) => allowed.get(result.chatId) !== result.transcriptViewId,
    )) {
      throw new Error('SEARCH_INDEX_INVALID_RESPONSE');
    }
    return { results: event.results, index: event.index };
  }

  async disableAndDelete(signal: AbortSignal): Promise<void> {
    this.#enabled = false;
    await this.#drainWrites();
    await this.#stopWorkers();
    signal.throwIfAborted();
    await fs.rm(this.#searchDirectory, { recursive: true, force: true });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#enabled = false;
    await this.#drainWrites();
    await this.#stopWorkers();
  }

  #trackWrite(work: () => Promise<void>): Promise<void> {
    if (!this.#enabled || this.#closed) return Promise.resolve();
    const admittedAfter = this.#admissionGate;
    const result = admittedAfter.then(() => {
      if (!this.#enabled || this.#closed) return;
      return work();
    });
    this.#inFlightWrites.add(result);
    const remove = () => this.#inFlightWrites.delete(result);
    void result.then(remove, remove);
    return result;
  }

  #runExclusiveWrite(work: () => Promise<void>): Promise<void> {
    if (!this.#enabled || this.#closed) return Promise.resolve();
    const priorAdmission = this.#admissionGate;
    let release = () => {};
    const closedGate = new Promise<void>((resolve) => { release = resolve; });
    this.#admissionGate = priorAdmission.then(() => closedGate);
    const admittedBefore = [...this.#inFlightWrites];
    return priorAdmission.then(async () => {
      try {
        await Promise.allSettled(admittedBefore);
        if (!this.#enabled || this.#closed) return;
        await work();
      } finally {
        release();
      }
    });
  }

  async #drainWrites(): Promise<void> {
    await this.#admissionGate;
    await Promise.allSettled([...this.#inFlightWrites]);
  }

  #requestIndexer(
    input: WorkerRequestInput<IndexerRequest>,
    signal?: AbortSignal,
  ): Promise<IndexerEvent> {
    return this.#indexer.request([input], signal, REQUEST_TIMEOUT_MS);
  }

  #requestIndexerFrames(inputs: readonly WorkerRequestInput<IndexerRequest>[]): Promise<IndexerEvent> {
    return this.#indexer.request(inputs, undefined, REQUEST_TIMEOUT_MS);
  }

  #requestReader(
    input: WorkerRequestInput<ReaderRequest>,
    signal?: AbortSignal,
  ): Promise<ReaderEvent> {
    return this.#reader.request([input], signal, REQUEST_TIMEOUT_MS);
  }

  async #stopWorkers(): Promise<void> {
    await Promise.all([
      this.#reader.stop({ type: 'close' }, WORKER_CLOSE_TIMEOUT_MS),
      this.#indexer.stop({ type: 'close' }, WORKER_CLOSE_TIMEOUT_MS),
    ]);
  }
}

function chunkRows(rows: readonly HistoricalSearchMessageRow[]): HistoricalSearchMessageRow[][] {
  const chunks: HistoricalSearchMessageRow[][] = [];
  let current: HistoricalSearchMessageRow[] = [];
  let bytes = 2;
  for (const row of rows) {
    const rowBytes = Buffer.byteLength(JSON.stringify(row)) + (current.length > 0 ? 1 : 0);
    if (rowBytes > MAX_FRAME_BYTES) throw new Error('SEARCH_ROW_TOO_LARGE');
    if (current.length >= MAX_ROWS_PER_FRAME || bytes + rowBytes > MAX_FRAME_BYTES) {
      chunks.push(current);
      current = [];
      bytes = 2;
    }
    current.push(row);
    bytes += rowBytes;
  }
  if (current.length > 0 || chunks.length === 0) chunks.push(current);
  return chunks;
}

function indexFrames(
  mode: 'replace' | 'append',
  input: TranscriptSearchIndexInput,
): readonly WorkerRequestInput<IndexerRequest>[] {
  const chunks = chunkRows(input.rows);
  return [
    {
      type: 'index-start',
      mode,
      chatId: input.chatId,
      transcriptViewId: input.transcriptViewId,
      expectedAfterOrdinal: input.expectedAfterOrdinal,
      throughOrdinal: input.throughOrdinal,
    },
    ...chunks.map((rows, chunkIndex) => ({
      type: 'index-chunk' as const,
      chunkIndex,
      rows,
      done: chunkIndex === chunks.length - 1,
    })),
  ];
}

function searchFrames(
  query: ChatSearchQueryV1,
  allowedChats: readonly TranscriptSearchAllowedChat[],
  limit: number,
): readonly WorkerRequestInput<ReaderRequest>[] {
  const frames: WorkerRequestInput<ReaderRequest>[] = [{ type: 'search-start', query, limit }];
  if (allowedChats.length === 0) {
    frames.push({ type: 'search-allowlist-chunk', chunkIndex: 0, allowedChats: [], done: true });
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
  return event.type === 'error' ? new Error(event.code) : null;
}
