import type { Database } from 'bun:sqlite';
import type { HistoricalSearchMessageRow } from './rows.js';
import {
  SEARCH_INGEST_ROW_MAX_BYTES,
  SEARCH_INGEST_TXN_MAX_BYTES,
  SEARCH_INGEST_TXN_MAX_ROWS,
  closeSearchDatabase,
  deleteChatBatch,
  deleteStaleRowsBatch,
  finishChatSync,
  insertRowsBatch,
  listChatStates,
  markChatFailed,
  observeWalTruncate,
  openSearchDatabase,
  planChatSync,
  runIdleMaintenance,
  statusCounts,
} from './schema.js';
import type { IndexerEvent, IndexerRequest } from './worker-protocol.js';

const INGEST_DUTY_RATIO = 0.5;
const SEARCH_CLEANUP_BATCHES_PER_REQUEST = 8;
const TRUNCATE_RETRY_LIMIT = 5;
const TRUNCATE_RETRY_DELAY_MS = 1_000;

interface ActiveSync {
  readonly chatId: string;
  readonly transcriptViewId: string;
  readonly targetThrough: number;
  nextFrameIndex: number;
  indexedThrough: number;
  staleRowsRemaining: boolean;
}

let db: Database | null = null;
let lifecycleEpoch = '';
let closing = false;
let dutyDebtMs = 0;
const syncs = new Map<number, ActiveSync>();

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

async function payDuty<T>(work: () => T): Promise<T> {
  const started = performance.now();
  try {
    return work();
  } finally {
    const busyMs = performance.now() - started;
    dutyDebtMs += busyMs * (1 - INGEST_DUTY_RATIO) / INGEST_DUTY_RATIO;
    if (dutyDebtMs >= 1) {
      const sleepMs = Math.floor(dutyDebtMs);
      dutyDebtMs -= sleepMs;
      await Bun.sleep(sleepMs);
    } else {
      await Bun.sleep(0);
    }
  }
}

function sliceBatches(
  rows: readonly HistoricalSearchMessageRow[],
): HistoricalSearchMessageRow[][] {
  const batches: HistoricalSearchMessageRow[][] = [];
  let current: HistoricalSearchMessageRow[] = [];
  let bytes = 0;
  for (const row of rows) {
    const rowBytes = Buffer.byteLength(row.body, 'utf8');
    if (rowBytes > SEARCH_INGEST_ROW_MAX_BYTES) throw new Error('SEARCH_ROW_TOO_LARGE');
    if (
      current.length >= SEARCH_INGEST_TXN_MAX_ROWS
      || (current.length > 0 && bytes + rowBytes > SEARCH_INGEST_TXN_MAX_BYTES)
    ) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(row);
    bytes += rowBytes;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

async function applySyncRows(
  request: Extract<IndexerRequest, { type: 'sync-rows' }>,
  sync: ActiveSync,
): Promise<void> {
  const database = requireDb();
  const batches = sliceBatches(request.rows);
  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index]!;
    const last = index === batches.length - 1;
    const advanceTo = last ? request.advanceTo : batch[batch.length - 1]!.ordinal;
    const state = await payDuty(() => insertRowsBatch(database, {
      chatId: sync.chatId,
      transcriptViewId: sync.transcriptViewId,
      rows: batch,
      advanceTo,
    }));
    sync.indexedThrough = state.indexedThrough;
    if (closing) throw new Error('INDEXER_UNAVAILABLE');
  }
  if (batches.length === 0 && request.advanceTo > sync.indexedThrough) {
    const state = await payDuty(() => insertRowsBatch(requireDb(), {
      chatId: sync.chatId,
      transcriptViewId: sync.transcriptViewId,
      rows: [],
      advanceTo: request.advanceTo,
    }));
    sync.indexedThrough = state.indexedThrough;
  }
}

async function truncateWalWithRetry(): Promise<number> {
  const database = requireDb();
  for (let attempt = 0; attempt < TRUNCATE_RETRY_LIMIT; attempt += 1) {
    const status = observeWalTruncate(database);
    if (status.busy === 0) return 0;
    await Bun.sleep(TRUNCATE_RETRY_DELAY_MS);
  }
  return 1;
}

function activeSyncFor(request: IndexerRequest): ActiveSync {
  const sync = syncs.get(request.requestId);
  if (!sync) throw new Error('INVALID_INDEX_REQUEST');
  return sync;
}

export async function handleIndexerRequest(request: IndexerRequest): Promise<void> {
  if (request.type !== 'open' && request.lifecycleEpoch !== lifecycleEpoch) return;
  try {
    switch (request.type) {
      case 'open': {
        lifecycleEpoch = request.lifecycleEpoch;
        closing = false;
        syncs.clear();
        if (db) closeSearchDatabase(db);
        const opened = await openSearchDatabase(request.dbPath);
        db = opened.db;
        post({ type: 'opened', ...response(request), recreated: opened.recreated });
        return;
      }
      case 'chat-states':
        post({
          type: 'chat-states-result',
          ...response(request),
          states: listChatStates(requireDb()),
        });
        return;
      case 'sync-begin': {
        const database = requireDb();
        if (syncs.has(request.requestId)) throw new Error('INVALID_INDEX_REQUEST');
        const outcome = planChatSync(database, request);
        if (outcome.plan === 'current') {
          post({
            type: 'sync-accepted',
            ...response(request),
            indexedThrough: outcome.state.indexedThrough,
            current: true,
            staleRows: false,
          });
          return;
        }
        syncs.set(request.requestId, {
          chatId: request.chatId,
          transcriptViewId: request.transcriptViewId,
          targetThrough: request.targetThrough,
          nextFrameIndex: 0,
          indexedThrough: outcome.state.indexedThrough,
          staleRowsRemaining: outcome.staleRows,
        });
        post({
          type: 'sync-accepted',
          ...response(request),
          indexedThrough: outcome.state.indexedThrough,
          current: false,
          staleRows: outcome.staleRows,
        });
        return;
      }
      case 'sync-cleanup': {
        const database = requireDb();
        const sync = activeSyncFor(request);
        let deletedRows = 0;
        let remaining = sync.staleRowsRemaining;
        for (
          let batch = 0;
          batch < SEARCH_CLEANUP_BATCHES_PER_REQUEST && remaining;
          batch += 1
        ) {
          const deleted = await payDuty(() => deleteStaleRowsBatch(database, {
            chatId: sync.chatId,
            keepViewId: sync.transcriptViewId,
            keepThrough: sync.indexedThrough,
          }));
          deletedRows += deleted;
          remaining = deleted > 0;
          if (closing) throw new Error('INDEXER_UNAVAILABLE');
        }
        sync.staleRowsRemaining = remaining;
        post({ type: 'cleanup-progress', ...response(request), deletedRows, remaining });
        return;
      }
      case 'sync-rows': {
        const sync = activeSyncFor(request);
        if (sync.staleRowsRemaining || sync.nextFrameIndex !== request.frameIndex) {
          throw new Error('INVALID_INDEX_FRAME');
        }
        sync.nextFrameIndex += 1;
        await applySyncRows(request, sync);
        post({
          type: 'sync-progress',
          ...response(request),
          frameIndex: request.frameIndex,
          indexedThrough: sync.indexedThrough,
        });
        return;
      }
      case 'sync-finish': {
        const sync = activeSyncFor(request);
        if (sync.staleRowsRemaining) throw new Error('INVALID_INDEX_FRAME');
        syncs.delete(request.requestId);
        const state = finishChatSync(requireDb(), {
          chatId: sync.chatId,
          transcriptViewId: sync.transcriptViewId,
        });
        post({ type: 'sync-complete', ...response(request), state });
        return;
      }
      case 'mark-failed':
        markChatFailed(requireDb(), request);
        post({ type: 'ack', ...response(request) });
        return;
      case 'delete-chat': {
        const database = requireDb();
        while (true) {
          const batch = await payDuty(() => deleteChatBatch(database, request.chatId));
          if (batch.deletedRows > 0) {
            post({ type: 'delete-progress', ...response(request), deletedRows: batch.deletedRows });
          }
          if (batch.done) break;
          if (closing) throw new Error('INDEXER_UNAVAILABLE');
        }
        post({ type: 'ack', ...response(request) });
        return;
      }
      case 'maintenance':
        await payDuty(() => runIdleMaintenance(requireDb()));
        post({ type: 'ack', ...response(request) });
        return;
      case 'status-snapshot':
        post({ type: 'status-result', ...response(request), counts: statusCounts(requireDb()) });
        return;
      case 'checkpoint': {
        const busy = await truncateWalWithRetry();
        post({ type: 'checkpoint-complete', ...response(request), busy });
        return;
      }
      case 'close':
        closing = true;
        syncs.clear();
        if (db) closeSearchDatabase(db);
        db = null;
        post({ type: 'closed', ...response(request) });
        process.exit(0);
    }
  } catch (error) {
    syncs.delete(request.requestId);
    const code = explicitErrorCode(error);
    post({
      type: 'error',
      ...response(request),
      code,
      retryable: code === 'INDEXER_INTERNAL' || code === 'INDEXER_UNAVAILABLE',
    });
  }
}
