import type { Database } from 'bun:sqlite';
import type { HistoricalSearchMessageRow } from './rows.js';
import {
  appendChatRows,
  closeSearchDatabase,
  deleteChatRows,
  openSearchDatabase,
  pruneMissingChats,
  replaceChatRows,
  runIdleMaintenance,
} from './schema.js';
import type { IndexerEvent, IndexerRequest } from './worker-protocol.js';

interface IndexBuild {
  readonly mode: 'replace' | 'append';
  readonly chatId: string;
  readonly transcriptViewId: string;
  readonly expectedAfterOrdinal: number;
  readonly throughOrdinal: number;
  readonly rows: HistoricalSearchMessageRow[];
  nextChunkIndex: number;
}

let db: Database | null = null;
let lifecycleEpoch = '';
let closing = false;
const builds = new Map<number, IndexBuild>();

function post(message: IndexerEvent): void {
  self.postMessage(message);
}

function response(request: IndexerRequest) {
  return { requestId: request.requestId, lifecycleEpoch: request.lifecycleEpoch };
}

function requireDb(): Database {
  if (!db || closing) throw new Error('INDEXER_UNAVAILABLE');
  return db;
}

function explicitErrorCode(error: unknown): string {
  return error instanceof Error && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.message)
    ? error.message
    : 'INDEXER_INTERNAL';
}

export async function handleIndexerRequest(request: IndexerRequest): Promise<void> {
  if (request.type !== 'open' && request.lifecycleEpoch !== lifecycleEpoch) return;
  try {
    switch (request.type) {
      case 'open': {
        lifecycleEpoch = request.lifecycleEpoch;
        closing = false;
        builds.clear();
        if (db) closeSearchDatabase(db);
        db = (await openSearchDatabase(request.dbPath)).db;
        post({ type: 'opened', ...response(request) });
        return;
      }
      case 'index-start':
        requireDb();
        if (builds.has(request.requestId)) throw new Error('INVALID_INDEX_REQUEST');
        builds.set(request.requestId, {
          mode: request.mode,
          chatId: request.chatId,
          transcriptViewId: request.transcriptViewId,
          expectedAfterOrdinal: request.expectedAfterOrdinal,
          throughOrdinal: request.throughOrdinal,
          rows: [],
          nextChunkIndex: 0,
        });
        return;
      case 'index-chunk': {
        const database = requireDb();
        const build = builds.get(request.requestId);
        if (!build || build.nextChunkIndex !== request.chunkIndex) {
          throw new Error('INVALID_INDEX_FRAME');
        }
        build.rows.push(...request.rows);
        build.nextChunkIndex += 1;
        if (!request.done) return;
        builds.delete(request.requestId);
        if (build.rows.some((row) => row.ordinal > build.throughOrdinal)) {
          throw new Error('INVALID_INDEX_FRAME');
        }
        if (build.mode === 'replace') {
          replaceChatRows(database, {
            chatId: build.chatId,
            transcriptViewId: build.transcriptViewId,
            throughOrdinal: build.throughOrdinal,
            rows: build.rows,
          });
        } else {
          appendChatRows(database, {
            chatId: build.chatId,
            transcriptViewId: build.transcriptViewId,
            expectedAfterOrdinal: build.expectedAfterOrdinal,
            throughOrdinal: build.throughOrdinal,
            rows: build.rows,
          });
        }
        post({ type: 'ack', ...response(request) });
        return;
      }
      case 'delete-chat':
        deleteChatRows(requireDb(), request.chatId);
        post({ type: 'ack', ...response(request) });
        return;
      case 'prune-chats':
        pruneMissingChats(requireDb(), request.chatIds);
        runIdleMaintenance(requireDb());
        post({ type: 'ack', ...response(request) });
        return;
      case 'close':
        closing = true;
        builds.clear();
        if (db) closeSearchDatabase(db);
        db = null;
        post({ type: 'closed', ...response(request) });
        self.close();
        return;
    }
  } catch (error) {
    builds.delete(request.requestId);
    const code = explicitErrorCode(error);
    post({
      type: 'error',
      ...response(request),
      code,
      retryable: code === 'INDEXER_INTERNAL' || code === 'INDEXER_UNAVAILABLE',
    });
  }
}
