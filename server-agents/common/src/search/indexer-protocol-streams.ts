import { parseChatMessages, type ChatMessage } from '@garcon/common/chat-types';
import { AgentTranscriptIndexError } from '@garcon/server-agent-interface';
import { TRANSCRIPT_INDEX_LOAD_LIMITS } from './indexer-job-data.js';
import type { IndexerEvent, IndexerRequest } from './worker-protocol.js';
import { compareGeneration } from './worker-protocol.js';
import type {
  TranscriptSearchCatalogEntry,
  TranscriptSearchCatalogSnapshot,
} from './transcript-search-service.js';

type CatalogChunk = Extract<IndexerRequest, { type: 'catalog-chunk' }>;
type CarryOverChunk = Extract<IndexerRequest, { type: 'carry-over-chunk' }>;
type CarryOverEntry = Pick<
  TranscriptSearchCatalogEntry,
  'agentId' | 'carryOverRevision' | 'chatId' | 'model'
>;

interface CatalogAssembly {
  readonly generation: CatalogChunk['generation'];
  readonly chats: TranscriptSearchCatalogEntry[];
  readonly timer: ReturnType<typeof setTimeout>;
  readonly lifecycleEpoch: string;
  nextChunkIndex: number;
}

const CARRY_OVER_CHUNK_TIMEOUT_MS = 5_000;
const FRAME_ASSEMBLY_TIMEOUT_MS = 5_000;

export class IndexerCatalogFrames {
  readonly #assemblies = new Map<number, CatalogAssembly>();

  constructor(private readonly post: (event: IndexerEvent) => void) {}

  accept(request: CatalogChunk): TranscriptSearchCatalogSnapshot | null {
    if (!Number.isSafeInteger(request.chunkIndex) || request.chunkIndex < 0
        || request.chats.length > 500
        || Buffer.byteLength(JSON.stringify(request.chats)) > 8 * 1024 * 1024) {
      throw new Error('INVALID_CATALOG_FRAME');
    }
    const existing = this.#assemblies.get(request.requestId);
    const assembly = existing ?? this.#createAssembly(request);
    if (!existing) this.#assemblies.set(request.requestId, assembly);
    if (assembly.nextChunkIndex !== request.chunkIndex
        || compareGeneration(assembly.generation, request.generation) !== 0) {
      this.discard(request.requestId);
      throw new Error('INVALID_CATALOG_FRAME');
    }
    assembly.chats.push(...request.chats);
    assembly.nextChunkIndex += 1;
    if (!request.done) return null;
    this.discard(request.requestId);
    return { generation: assembly.generation, chats: assembly.chats };
  }

  discard(requestId: number): void {
    const assembly = this.#assemblies.get(requestId);
    if (!assembly) return;
    clearTimeout(assembly.timer);
    this.#assemblies.delete(requestId);
  }

  clear(): void {
    for (const requestId of this.#assemblies.keys()) this.discard(requestId);
  }

  #createAssembly(request: CatalogChunk): CatalogAssembly {
    const timer = setTimeout(() => {
      const current = this.#assemblies.get(request.requestId);
      if (!current || current.lifecycleEpoch !== request.lifecycleEpoch) return;
      this.#assemblies.delete(request.requestId);
      this.post({
        type: 'error',
        requestId: request.requestId,
        lifecycleEpoch: request.lifecycleEpoch,
        code: 'CATALOG_FRAME_TIMEOUT',
        retryable: true,
      });
    }, FRAME_ASSEMBLY_TIMEOUT_MS);
    timer.unref?.();
    return {
      generation: request.generation,
      chats: [],
      timer,
      lifecycleEpoch: request.lifecycleEpoch,
      nextChunkIndex: 0,
    };
  }
}

export class IndexerCarryOverStream {
  readonly #waiters = new Map<number, {
    resolve(value: CarryOverChunk): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  #requestId = 1_000_000;

  constructor(
    private readonly post: (event: IndexerEvent) => void,
    private readonly lifecycleEpoch: () => string,
  ) {}

  accept(request: CarryOverChunk): void {
    const waiter = this.#waiters.get(request.requestId);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.#waiters.delete(request.requestId);
    waiter.resolve(request);
  }

  cancelAll(): void {
    for (const waiter of this.#waiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('CARRY_OVER_CANCELLED'));
    }
    this.#waiters.clear();
  }

  async *batches(entry: CarryOverEntry, signal: AbortSignal): AsyncIterable<readonly ChatMessage[]> {
    if (entry.carryOverRevision === 'carry-v1:0') return;
    const requestId = ++this.#requestId;
    this.post({
      type: 'carry-over-open',
      requestId,
      lifecycleEpoch: this.lifecycleEpoch(),
      chatId: entry.chatId,
      expectedRevision: entry.carryOverRevision,
      currentAgentId: entry.agentId,
      currentModel: entry.model,
    });
    try {
      let expectedChunkIndex = 0;
      while (true) {
        signal.throwIfAborted();
        const chunk = await this.#nextChunk(requestId);
        if (chunk.chunkIndex !== expectedChunkIndex
            || chunk.messages.length > TRANSCRIPT_INDEX_LOAD_LIMITS.maxMessagesPerBatch
            || Buffer.byteLength(JSON.stringify(chunk.messages))
              > TRANSCRIPT_INDEX_LOAD_LIMITS.maxBatchBytes) {
          throw new Error('INVALID_CARRY_OVER_FRAME');
        }
        expectedChunkIndex += 1;
        if (chunk.code) {
          throw new AgentTranscriptIndexError({
            kind: 'agent-transcript-index-failure',
            code: chunk.code,
            retryable: chunk.retryable === true,
            refreshSource: false,
          });
        }
        if (chunk.revision !== entry.carryOverRevision) {
          throw new Error('CARRY_OVER_REVISION_CHANGED');
        }
        yield parseChatMessages(chunk.messages);
        if (chunk.done) return;
        this.post({
          type: 'carry-over-pull',
          requestId,
          lifecycleEpoch: this.lifecycleEpoch(),
        });
      }
    } finally {
      const waiter = this.#waiters.get(requestId);
      if (waiter) {
        clearTimeout(waiter.timer);
        this.#waiters.delete(requestId);
      }
      this.post({
        type: 'carry-over-cancel',
        requestId,
        lifecycleEpoch: this.lifecycleEpoch(),
      });
    }
  }

  async #nextChunk(requestId: number): Promise<CarryOverChunk> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiters.delete(requestId);
        reject(new Error('CARRY_OVER_TIMEOUT'));
      }, CARRY_OVER_CHUNK_TIMEOUT_MS);
      timer.unref?.();
      this.#waiters.set(requestId, { resolve, reject, timer });
    });
  }
}
