import type { Database } from 'bun:sqlite';
import { errorMessage } from '../../lib/errors.js';
import {
  appendChatRows,
  closeSearchDatabase,
  deleteChatRows,
  loadPersistedGenerations,
  markChatStatus,
  openSearchDatabase,
  prepareChatBuild,
  pruneMissingChats,
  replaceChatFromStaging,
  runIdleMaintenance,
  stageChatRows,
} from './schema.js';
import { searchTranscriptIndex } from './query.js';
import { loadTranscriptBuildBatches, probeTranscriptBuildSource } from './source-registry.js';
import {
  isTranscriptSearchWorkerRequest,
  type TranscriptSearchProgressEvent,
  type TranscriptSearchWorkerErrorCode,
  type TranscriptSearchWorkerRequest,
  type TranscriptSearchWorkerResponse,
} from './worker-protocol.js';
import { TranscriptSearchWorkerScheduler } from './worker-scheduler.js';

let db: Database | null = null;
let lifecycleEpoch = 0;
let closing = false;
let processedRowCount = 0;
let latestGenerationByChat = new Map<string, number>();
let maintenanceTimer: ReturnType<typeof setTimeout> | null = null;
let progressTimer: ReturnType<typeof setTimeout> | null = null;
let lastProgressAt = 0;
const activeBuilds = new Map<string, AbortController>();
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

function emitProgress(): void {
  if (!db || closing) return;
  lastProgressAt = Date.now();
  const counts = db.query<{
    indexed: number;
    pending: number;
    failed: number;
    unsupported: number;
  }, []>(`
    SELECT
      COALESCE(SUM(CASE WHEN status IN ('sealed', 'dirty') THEN 1 ELSE 0 END), 0) AS indexed,
      COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
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

function progress(force = false): void {
  if (!db || closing) return;
  const remaining = 1_000 - (Date.now() - lastProgressAt);
  if (force || remaining <= 0) {
    if (progressTimer) clearTimeout(progressTimer);
    progressTimer = null;
    emitProgress();
    return;
  }
  if (progressTimer) return;
  progressTimer = setTimeout(() => {
    progressTimer = null;
    emitProgress();
  }, remaining);
  progressTimer.unref?.();
}

function generationAccepted(chatId: string, generation: number): boolean {
  const latest = latestGenerationByChat.get(chatId) ?? 0;
  if (generation < latest) return false;
  latestGenerationByChat.set(chatId, generation);
  if (generation > latest) activeBuilds.get(chatId)?.abort();
  return true;
}

async function rebuildChat(
  request: Extract<TranscriptSearchWorkerRequest, { type: 'rebuild-chat' }>,
  yieldAfterSlice: () => Promise<void>,
): Promise<void> {
  if (latestGenerationByChat.get(request.chatId) !== request.generation) {
    post({ type: 'ack', ...responseBase(request) });
    return;
  }
  const abortController = new AbortController();
  activeBuilds.set(request.chatId, abortController);
  try {
    const probe = await probeTranscriptBuildSource(request.buildSource);
    if (latestGenerationByChat.get(request.chatId) !== request.generation) {
      post({ type: 'ack', ...responseBase(request) });
      return;
    }
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
    prepareChatBuild(requireDb());
    progress(true);
    const loaded = await loadTranscriptBuildBatches(request.chatId, request.buildSource, {
      signal: abortController.signal,
      async onRows(rows) {
        if (abortController.signal.aborted
            || closing
            || request.lifecycleEpoch !== lifecycleEpoch
            || latestGenerationByChat.get(request.chatId) !== request.generation) {
          throw new DOMException('Transcript search load cancelled', 'AbortError');
        }
        if (rows.length > 0) stageChatRows(requireDb(), rows);
        await yieldAfterSlice();
      },
    });
    if (closing || request.lifecycleEpoch !== lifecycleEpoch) return;
    if (latestGenerationByChat.get(request.chatId) !== request.generation) {
      post({ type: 'ack', ...responseBase(request) });
      return;
    }
    replaceChatFromStaging(
      requireDb(),
      request.chatId,
      request.generation,
      loaded.sourceKey,
      loaded.rowCount,
    );
    processedRowCount += loaded.rowCount;
    post({ type: 'ack', ...responseBase(request) });
  } catch (error) {
    const superseded = closing
      || request.lifecycleEpoch !== lifecycleEpoch
      || latestGenerationByChat.get(request.chatId) !== request.generation
      || abortController.signal.aborted;
    if (superseded) {
      if (!closing) post({ type: 'ack', ...responseBase(request) });
      return;
    }
    const sourceChanged = errorMessage(error).includes('source changed');
    markChatStatus(
      requireDb(),
      request.chatId,
      request.generation,
      sourceChanged ? 'dirty' : 'failed',
      sourceChanged ? 'source-changed' : 'source-unavailable',
    );
    post({
      type: 'error',
      ...responseBase(request),
      code: sourceChanged ? 'SOURCE_CHANGED' : 'SOURCE_UNAVAILABLE',
      message: errorMessage(error),
      retryable: true,
    });
  } finally {
    if (activeBuilds.get(request.chatId) === abortController) activeBuilds.delete(request.chatId);
    progress(true);
  }
}

function scheduleMaintenance(): void {
  if (maintenanceTimer) clearTimeout(maintenanceTimer);
  maintenanceTimer = setTimeout(() => {
    maintenanceTimer = null;
    if (db && !closing) scheduler.runBackground(async (yieldAfterSlice) => {
      runIdleMaintenance(requireDb());
      await yieldAfterSlice();
    }).catch(() => undefined);
  }, 1_000);
  maintenanceTimer.unref?.();
}

async function handle(request: TranscriptSearchWorkerRequest): Promise<void> {
  if (request.type !== 'open' && request.lifecycleEpoch !== lifecycleEpoch) return;
  try {
    switch (request.type) {
      case 'open': {
        if (db) throw new Error('Transcript search worker is already open');
        lifecycleEpoch = request.lifecycleEpoch;
        closing = false;
        const opened = await openSearchDatabase(request.dbPath);
        db = opened.db;
        latestGenerationByChat = loadPersistedGenerations(db);
        const generationFloor = Math.max(0, ...latestGenerationByChat.values());
        post({ type: 'opened', generationFloor, ...responseBase(request) });
        progress(true);
        return;
      }
      case 'rebuild-chat':
        if (!generationAccepted(request.chatId, request.generation)) {
          post({ type: 'ack', ...responseBase(request) });
          return;
        }
        await scheduler.runBackground((yieldAfterSlice) => rebuildChat(request, yieldAfterSlice));
        return;
      case 'append':
        scheduler.wakeInteractive();
        if (generationAccepted(request.chatId, request.generation)
            && appendChatRows(requireDb(), request.chatId, request.generation, request.rows)) {
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
      case 'mark-failed':
        scheduler.wakeInteractive();
        if (generationAccepted(request.chatId, request.generation)) {
          markChatStatus(
            requireDb(),
            request.chatId,
            request.generation,
            'failed',
            request.reasonCode,
          );
        }
        post({ type: 'ack', ...responseBase(request) });
        progress();
        return;
      case 'mark-unsupported':
        scheduler.wakeInteractive();
        if (generationAccepted(request.chatId, request.generation)) {
          const messageCount = Number(requireDb().query<{ count: number }, [string]>(`
            SELECT message_count AS count FROM search_chat_state WHERE chat_id = ?
          `).get(request.chatId)?.count ?? 0);
          markChatStatus(
            requireDb(),
            request.chatId,
            request.generation,
            messageCount > 0 ? 'dirty' : 'unsupported',
            messageCount > 0 ? null : request.reasonCode,
          );
        }
        post({ type: 'ack', ...responseBase(request) });
        progress();
        return;
      case 'delete-chat':
        scheduler.wakeInteractive();
        if (generationAccepted(request.chatId, request.generation)) {
          deleteChatRows(requireDb(), request.chatId, request.generation);
        }
        post({ type: 'ack', ...responseBase(request) });
        progress(true);
        scheduleMaintenance();
        return;
      case 'prune-chats': {
        scheduler.wakeInteractive();
        const pruned = pruneMissingChats(requireDb(), request.registeredChatIds);
        for (const chatId of pruned) {
          latestGenerationByChat.delete(chatId);
          activeBuilds.get(chatId)?.abort();
        }
        post({ type: 'ack', ...responseBase(request) });
        progress(true);
        if (pruned.length > 0) scheduleMaintenance();
        return;
      }
      case 'search': {
        scheduler.wakeInteractive();
        const result = searchTranscriptIndex(requireDb(), request);
        post({ type: 'search-result', ...responseBase(request), ...result });
        return;
      }
      case 'close': {
        scheduler.wakeInteractive();
        closing = true;
        for (const controller of activeBuilds.values()) controller.abort();
        activeBuilds.clear();
        if (maintenanceTimer) clearTimeout(maintenanceTimer);
        if (progressTimer) clearTimeout(progressTimer);
        maintenanceTimer = null;
        progressTimer = null;
        const active = db;
        db = null;
        if (active) closeSearchDatabase(active);
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
      retryable: request.type !== 'close',
    });
  }
}

self.onmessage = (event: MessageEvent<unknown>) => {
  if (isTranscriptSearchWorkerRequest(event.data)) {
    void handle(event.data);
    return;
  }
  const raw = event.data as { requestId?: unknown; lifecycleEpoch?: unknown } | null;
  if (raw
      && typeof raw.requestId === 'number'
      && typeof raw.lifecycleEpoch === 'number') {
    post({
      type: 'error',
      requestId: raw.requestId,
      lifecycleEpoch: raw.lifecycleEpoch,
      code: 'INVALID_REQUEST',
      message: 'Transcript search worker request is invalid',
      retryable: false,
    });
  }
};
