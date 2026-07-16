import type { Database } from 'bun:sqlite';
import { errorMessage } from '../../lib/errors.js';
import {
  appendChatRows,
  deleteChatRows,
  markChatStatus,
  openSearchDatabase,
  replaceChatRows,
  runIdleMaintenance,
} from './schema.js';
import { searchTranscriptIndex } from './query.js';
import { loadTranscriptBuildRows, probeTranscriptBuildSource } from './source-registry.js';
import type {
  TranscriptSearchProgressEvent,
  TranscriptSearchWorkerErrorCode,
  TranscriptSearchWorkerRequest,
  TranscriptSearchWorkerResponse,
} from './worker-protocol.js';
import { TranscriptSearchWorkerScheduler } from './worker-scheduler.js';

let db: Database | null = null;
let lifecycleEpoch = 0;
let closing = false;
let processedRowCount = 0;
const latestGenerationByChat = new Map<string, number>();
let maintenanceTimer: ReturnType<typeof setTimeout> | null = null;
const scheduler = new TranscriptSearchWorkerScheduler();

function post(message: TranscriptSearchWorkerResponse | TranscriptSearchProgressEvent): void {
  self.postMessage(message);
}

function responseBase(request: TranscriptSearchWorkerRequest) {
  return { requestId: request.requestId, lifecycleEpoch: request.lifecycleEpoch };
}

function requireDb(): Database {
  if (!db || closing) throw new Error('Transcript search database is not open');
  return db;
}

function errorCodeFor(request: TranscriptSearchWorkerRequest): TranscriptSearchWorkerErrorCode {
  if (request.type === 'open') return 'OPEN_FAILED';
  if (request.type === 'search') return 'SEARCH_FAILED';
  if (request.type === 'close') return 'CLOSE_FAILED';
  return 'SQLITE_ERROR';
}

function progress(): void {
  if (!db || closing) return;
  const counts = db.query<{
    indexed: number;
    pending: number;
    failed: number;
    unsupported: number;
  }, []>(`
    SELECT
      COALESCE(SUM(CASE WHEN status = 'sealed' THEN 1 ELSE 0 END), 0) AS indexed,
      COALESCE(SUM(CASE WHEN status IN ('pending', 'dirty') THEN 1 ELSE 0 END), 0) AS pending,
      COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
      COALESCE(SUM(CASE WHEN status = 'unsupported' THEN 1 ELSE 0 END), 0) AS unsupported
    FROM search_chat_state
  `).get() ?? { indexed: 0, pending: 0, failed: 0, unsupported: 0 };
  const pendingChatCount = Number(counts.pending);
  post({
    type: 'progress',
    lifecycleEpoch,
    phase: pendingChatCount > 0 ? 'building' : 'ready',
    indexedChatCount: Number(counts.indexed),
    pendingChatCount,
    failedChatCount: Number(counts.failed),
    unsupportedChatCount: Number(counts.unsupported),
    processedRowCount,
  });
}

function generationAccepted(chatId: string, generation: number): boolean {
  const latest = latestGenerationByChat.get(chatId) ?? 0;
  if (generation < latest) return false;
  latestGenerationByChat.set(chatId, generation);
  return true;
}

async function rebuildChat(
  request: Extract<TranscriptSearchWorkerRequest, { type: 'rebuild-chat' }>,
): Promise<void> {
  if (!generationAccepted(request.chatId, request.generation)) {
    post({ type: 'ack', ...responseBase(request) });
    return;
  }
  const probe = await probeTranscriptBuildSource(request.buildSource);
  const existing = requireDb().query<{ sourceKey: string | null; status: string }, [string]>(`
    SELECT source_key AS sourceKey, status
    FROM search_chat_state
    WHERE chat_id = ?
  `).get(request.chatId);
  if (probe && existing?.status === 'sealed' && existing.sourceKey?.startsWith(`${probe}:sha256:`)) {
    post({ type: 'ack', ...responseBase(request) });
    return;
  }
  markChatStatus(requireDb(), request.chatId, request.generation, 'pending');
  progress();
  try {
    const loaded = await loadTranscriptBuildRows(request.chatId, request.buildSource);
    if (closing || request.lifecycleEpoch !== lifecycleEpoch) return;
    if (latestGenerationByChat.get(request.chatId) !== request.generation) {
      post({ type: 'ack', ...responseBase(request) });
      return;
    }
    replaceChatRows(
      requireDb(),
      request.chatId,
      request.generation,
      loaded.sourceKey,
      loaded.rows,
    );
    processedRowCount += loaded.rows.length;
    post({ type: 'ack', ...responseBase(request) });
  } catch (error) {
    if (!closing && latestGenerationByChat.get(request.chatId) === request.generation) {
      const sourceChanged = errorMessage(error).includes('source changed');
      markChatStatus(
        requireDb(),
        request.chatId,
        request.generation,
        'failed',
        sourceChanged ? 'source-changed' : 'source-unavailable',
      );
      post({
        type: 'error',
        ...responseBase(request),
        code: sourceChanged ? 'SOURCE_CHANGED' : 'SOURCE_UNAVAILABLE',
        message: errorMessage(error),
      });
    }
  } finally {
    progress();
  }
}

function scheduleMaintenance(): void {
  if (maintenanceTimer) clearTimeout(maintenanceTimer);
  maintenanceTimer = setTimeout(() => {
    maintenanceTimer = null;
    if (db && !closing) runIdleMaintenance(db);
  }, 1_000);
  maintenanceTimer.unref?.();
}

async function handle(request: TranscriptSearchWorkerRequest): Promise<void> {
  if (!request || typeof request !== 'object' || typeof request.type !== 'string') return;
  if (request.type !== 'open' && request.lifecycleEpoch !== lifecycleEpoch) return;
  try {
    switch (request.type) {
      case 'open': {
        if (db) throw new Error('Transcript search worker is already open');
        lifecycleEpoch = request.lifecycleEpoch;
        closing = false;
        const opened = await openSearchDatabase(request.dbPath);
        db = opened.db;
        post({ type: 'opened', ...responseBase(request) });
        progress();
        return;
      }
      case 'rebuild-chat':
        await scheduler.runBackground(() => rebuildChat(request));
        return;
      case 'append':
        scheduler.wakeInteractive();
        if (generationAccepted(request.chatId, request.generation)) {
          appendChatRows(requireDb(), request.chatId, request.generation, request.rows);
          processedRowCount += request.rows.length;
        }
        post({ type: 'ack', ...responseBase(request) });
        progress();
        return;
      case 'mark-dirty':
        scheduler.wakeInteractive();
        if (generationAccepted(request.chatId, request.generation)) {
          markChatStatus(requireDb(), request.chatId, request.generation, 'dirty');
        }
        post({ type: 'ack', ...responseBase(request) });
        progress();
        return;
      case 'mark-unsupported':
        scheduler.wakeInteractive();
        if (generationAccepted(request.chatId, request.generation)) {
          markChatStatus(
            requireDb(),
            request.chatId,
            request.generation,
            'unsupported',
            request.reasonCode,
          );
        }
        post({ type: 'ack', ...responseBase(request) });
        progress();
        return;
      case 'delete-chat':
        scheduler.wakeInteractive();
        generationAccepted(request.chatId, request.generation);
        db = deleteChatRows(requireDb(), request.chatId);
        post({ type: 'ack', ...responseBase(request) });
        progress();
        scheduleMaintenance();
        return;
      case 'search': {
        scheduler.wakeInteractive();
        const result = searchTranscriptIndex(requireDb(), request);
        post({ type: 'search-result', ...responseBase(request), ...result });
        return;
      }
      case 'close': {
        scheduler.wakeInteractive();
        closing = true;
        if (maintenanceTimer) clearTimeout(maintenanceTimer);
        maintenanceTimer = null;
        const active = db;
        db = null;
        active?.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        active?.close();
        post({ type: 'closed', ...responseBase(request) });
        self.close();
        return;
      }
    }
  } catch (error) {
    post({
      type: 'error',
      ...responseBase(request),
      code: errorCodeFor(request),
      message: errorMessage(error),
    });
  }
}

self.onmessage = (event: MessageEvent<TranscriptSearchWorkerRequest>) => {
  void handle(event.data);
};
