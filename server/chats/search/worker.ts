import type { Database } from 'bun:sqlite';
import { promises as fs } from 'fs';
import path from 'path';
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
  type TranscriptSearchFatalEvent,
  type TranscriptSearchProgressEvent,
  type TranscriptSearchWorkerErrorCode,
  type TranscriptSearchWorkerRequest,
  type TranscriptSearchWorkerResponse,
} from './worker-protocol.js';
import { transcriptSearchScratchDirectory } from './file-cleanup.js';
import { TranscriptSearchWorkerScheduler } from './worker-scheduler.js';

let db: Database | null = null;
let scratchDirectory: string | null = null;
let lifecycleEpoch = 0;
let closing = false;
let processedRowCount = 0;
let latestGenerationByChat = new Map<string, number>();
let maintenanceTimer: ReturnType<typeof setTimeout> | null = null;
let progressTimer: ReturnType<typeof setTimeout> | null = null;
let lastProgressAt = 0;
const activeBuilds = new Map<string, AbortController>();
const activeBuildTasks = new Map<string, Set<Promise<void>>>();
const scheduler = new TranscriptSearchWorkerScheduler();

function post(
  message: TranscriptSearchWorkerResponse | TranscriptSearchProgressEvent | TranscriptSearchFatalEvent,
): void {
  self.postMessage(message);
}

class TranscriptSearchStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TranscriptSearchStorageError';
  }
}

function storageOperation<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    throw new TranscriptSearchStorageError(errorMessage(error));
  }
}

function responseBase(request: TranscriptSearchWorkerRequest) {
  return { requestId: request.requestId, lifecycleEpoch: request.lifecycleEpoch };
}

function requireDb(): Database {
  if (!db || closing) throw new Error('Transcript search database is not open');
  return db;
}

function requireScratchDirectory(): string {
  if (!scratchDirectory || closing) throw new Error('Transcript search scratch directory is not open');
  return scratchDirectory;
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
      COALESCE(SUM(CASE
        WHEN status = 'sealed' OR (status = 'dirty' AND message_count > 0) THEN 1
        ELSE 0
      END), 0) AS indexed,
      COALESCE(SUM(CASE
        WHEN status = 'pending' OR (status = 'dirty' AND message_count = 0) THEN 1
        ELSE 0
      END), 0) AS pending,
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
  if (closing || request.lifecycleEpoch !== lifecycleEpoch) return;
  if (latestGenerationByChat.get(request.chatId) !== request.generation) {
    post({ type: 'ack', ...responseBase(request) });
    return;
  }
  const abortController = new AbortController();
  let acknowledged = false;
  const acknowledge = (): void => {
    if (acknowledged) return;
    acknowledged = true;
    post({ type: 'ack', ...responseBase(request) });
  };
  const acknowledgeCancellation = (): void => {
    if (!closing && request.lifecycleEpoch === lifecycleEpoch) acknowledge();
  };
  abortController.signal.addEventListener('abort', acknowledgeCancellation, { once: true });
  activeBuilds.set(request.chatId, abortController);
  try {
    const probe = await probeTranscriptBuildSource(request.buildSource, abortController.signal);
    if (latestGenerationByChat.get(request.chatId) !== request.generation) {
      acknowledge();
      return;
    }
    const existing = storageOperation(() => requireDb()
      .query<{ sourceKey: string | null; status: string }, [string]>(`
        SELECT source_key AS sourceKey, status
        FROM search_chat_state
        WHERE chat_id = ?
      `)
      .get(request.chatId));
    if (probe && existing?.status === 'sealed' && existing.sourceKey?.startsWith(`${probe}:sha256:`)) {
      post({ type: 'ack', ...responseBase(request) });
      return;
    }

    storageOperation(() => markChatStatus(requireDb(), request.chatId, request.generation, 'pending'));
    storageOperation(() => prepareChatBuild(requireDb()));
    storageOperation(() => progress(true));
    const loaded = await loadTranscriptBuildBatches(request.chatId, request.buildSource, {
      signal: abortController.signal,
      scratchDirectory: requireScratchDirectory(),
      async onRows(rows) {
        if (abortController.signal.aborted
            || closing
            || request.lifecycleEpoch !== lifecycleEpoch
            || latestGenerationByChat.get(request.chatId) !== request.generation) {
          throw new DOMException('Transcript search load cancelled', 'AbortError');
        }
        if (rows.length > 0) storageOperation(() => stageChatRows(requireDb(), rows));
        await yieldAfterSlice();
      },
    });
    if (closing || request.lifecycleEpoch !== lifecycleEpoch) return;
    if (latestGenerationByChat.get(request.chatId) !== request.generation) {
      acknowledge();
      return;
    }
    storageOperation(() => replaceChatFromStaging(
      requireDb(),
      request.chatId,
      request.generation,
      loaded.sourceKey,
      loaded.rowCount,
    ));
    processedRowCount += loaded.rowCount;
    acknowledge();
  } catch (error) {
    if (error instanceof TranscriptSearchStorageError) throw error;
    const superseded = closing
      || request.lifecycleEpoch !== lifecycleEpoch
      || latestGenerationByChat.get(request.chatId) !== request.generation
      || abortController.signal.aborted;
    if (superseded) {
      if (!closing) acknowledge();
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
    abortController.signal.removeEventListener('abort', acknowledgeCancellation);
    if (activeBuilds.get(request.chatId) === abortController) activeBuilds.delete(request.chatId);
    progress(true);
  }
}

async function waitForChatBuilds(chatId: string): Promise<void> {
  while (activeBuildTasks.get(chatId)?.size) {
    await Promise.allSettled([...activeBuildTasks.get(chatId) ?? []]);
  }
}

async function waitForAllBuilds(): Promise<void> {
  while (activeBuildTasks.size > 0) {
    await Promise.allSettled([...activeBuildTasks.values()].flatMap((tasks) => [...tasks]));
  }
}

function scheduleMaintenance(): void {
  if (maintenanceTimer) clearTimeout(maintenanceTimer);
  maintenanceTimer = setTimeout(() => {
    maintenanceTimer = null;
    if (db && !closing) void scheduler.runBackground(async (yieldAfterSlice) => {
      runIdleMaintenance(requireDb());
      await yieldAfterSlice();
    }).catch((error) => {
      if (!db || closing) return;
      post({
        type: 'fatal',
        lifecycleEpoch,
        code: 'SQLITE_ERROR',
        message: errorMessage(error),
      });
    });
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
        const nextScratchDirectory = transcriptSearchScratchDirectory(path.dirname(request.dbPath));
        await fs.rm(nextScratchDirectory, { recursive: true, force: true });
        await fs.mkdir(nextScratchDirectory, { recursive: true, mode: 0o700 });
        try {
          const opened = await openSearchDatabase(request.dbPath);
          db = opened.db;
          scratchDirectory = nextScratchDirectory;
        } catch (error) {
          await fs.rm(nextScratchDirectory, { recursive: true, force: true });
          throw error;
        }
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
        {
          const task = scheduler.runBackground((yieldAfterSlice) => rebuildChat(request, yieldAfterSlice));
          const tasks = activeBuildTasks.get(request.chatId) ?? new Set<Promise<void>>();
          tasks.add(task);
          activeBuildTasks.set(request.chatId, tasks);
          try {
            await task;
          } finally {
            tasks.delete(task);
            if (tasks.size === 0) activeBuildTasks.delete(request.chatId);
          }
        }
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
          await waitForChatBuilds(request.chatId);
          if (latestGenerationByChat.get(request.chatId) === request.generation) {
            db = deleteChatRows(requireDb(), request.chatId, request.generation);
          }
        }
        post({ type: 'ack', ...responseBase(request) });
        progress(true);
        scheduleMaintenance();
        return;
      case 'prune-chats': {
        scheduler.wakeInteractive();
        const registeredChatIds = new Set(request.registeredChatIds);
        const activePrunedChatIds = [...activeBuildTasks.keys()]
          .filter((chatId) => !registeredChatIds.has(chatId));
        for (const chatId of activePrunedChatIds) activeBuilds.get(chatId)?.abort();
        await Promise.all(activePrunedChatIds.map((chatId) => waitForChatBuilds(chatId)));
        const pruned = pruneMissingChats(requireDb(), request.registeredChatIds);
        db = pruned.db;
        for (const chatId of pruned.prunedChatIds) {
          latestGenerationByChat.delete(chatId);
          activeBuilds.get(chatId)?.abort();
        }
        post({ type: 'ack', ...responseBase(request) });
        progress(true);
        if (pruned.prunedChatIds.length > 0) scheduleMaintenance();
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
        await waitForAllBuilds();
        activeBuilds.clear();
        if (maintenanceTimer) clearTimeout(maintenanceTimer);
        if (progressTimer) clearTimeout(progressTimer);
        maintenanceTimer = null;
        progressTimer = null;
        const active = db;
        db = null;
        if (active) closeSearchDatabase(active);
        const scratch = scratchDirectory;
        scratchDirectory = null;
        if (scratch) await fs.rm(scratch, { recursive: true, force: true });
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
