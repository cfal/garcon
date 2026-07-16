import { promises as fs } from 'fs';
import path from 'path';
import type { ChatMessage } from '../../../common/chat-types.js';
import type { ChatSearchIndexStatus, ChatSearchResult } from '../../../common/chat-search.js';
import { errorMessage } from '../../lib/errors.js';
import { createLogger } from '../../lib/log.js';
import { withPromiseTimeout } from '../../lib/promise-timeout.js';
import { projectLiveMessages } from './message-projector.js';
import {
  deleteTranscriptSearchFiles,
  transcriptSearchDatabasePath,
} from './file-cleanup.js';
import type { SearchTranscriptLoadPlan, TranscriptBuildSource } from './source-types.js';
import {
  TranscriptSearchWorkerClient,
  TranscriptSearchWorkerError,
} from './worker-client.js';
import type {
  SearchMessageRowInput,
  TranscriptSearchProgressEvent,
} from './worker-protocol.js';

const logger = createLogger('chats:transcript-search');
const APPEND_FLUSH_MS = 250;
const APPEND_FLUSH_ROWS = 64;
const MAX_QUEUED_ROWS = 2_000;
const RESEAL_IDLE_MS = 60_000;
const SEARCH_TIMEOUT_MS = 2_000;
const RESTART_DELAYS_MS = [1_000, 5_000, 30_000] as const;
const RESTART_STABLE_MS = 30_000;
const SOURCE_RETRY_DELAYS_MS = [5_000, 30_000, 300_000] as const;

export type TranscriptSearchRuntimeState =
  | 'disabled'
  | 'starting'
  | 'building'
  | 'ready'
  | 'stopping'
  | 'degraded';

export class TranscriptSearchUnavailableError extends Error {
  constructor(
    public readonly code: 'TRANSCRIPT_SEARCH_DISABLED' | 'SEARCH_INDEX_UNAVAILABLE' | 'SEARCH_INDEX_BUSY',
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'TranscriptSearchUnavailableError';
  }
}

export interface TranscriptSearchChatSource {
  chatId: string;
  lastActivityAt: string | null;
  agentId: string;
  model: string;
}

export interface TranscriptSearchControllerDeps {
  workspaceDir: string;
  listChats(): TranscriptSearchChatSource[];
  resolveSearchLoadPlan(chatId: string): Promise<SearchTranscriptLoadPlan>;
  getCarryOverDescriptor(chatId: string): TranscriptBuildSource['carryOver'] | null;
  workerFactory?: () => Worker;
  cleanupRetryMs?: number;
}

interface AppendBuffer {
  rows: SearchMessageRowInput[];
  generation: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export class TranscriptSearchController {
  readonly #deps: TranscriptSearchControllerDeps;
  readonly #generationByChat = new Map<string, number>();
  readonly #appendBuffers = new Map<string, AppendBuffer>();
  readonly #resealTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #sourceRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #sourceRetryAttempts = new Map<string, number>();
  readonly #pendingDeletes = new Set<string>();
  readonly #dirtyRequests = new Set<string>();
  readonly #chatSources = new Map<string, TranscriptSearchChatSource>();
  #worker: TranscriptSearchWorkerClient | null = null;
  #runtimeState: TranscriptSearchRuntimeState = 'disabled';
  #progress: TranscriptSearchProgressEvent | null = null;
  #lifecycleEpoch = 0;
  #generationSeed = Date.now() * 1_000;
  #queuedRows = 0;
  #desiredEnabled = false;
  #cleanupRetryTimer: ReturnType<typeof setTimeout> | null = null;
  #restartTimer: ReturnType<typeof setTimeout> | null = null;
  #restartResetTimer: ReturnType<typeof setTimeout> | null = null;
  #restartAttempt = 0;
  #reconcileTask: Promise<void> | null = null;
  #searchInFlight: Promise<unknown> | null = null;
  #requiresFreshIndex = false;

  constructor(deps: TranscriptSearchControllerDeps) {
    this.#deps = deps;
  }

  get runtimeState(): TranscriptSearchRuntimeState {
    return this.#runtimeState;
  }

  get progress(): TranscriptSearchProgressEvent | null {
    return this.#progress;
  }

  async initialize(enabled: boolean): Promise<void> {
    this.#desiredEnabled = enabled;
    this.#restartAttempt = 0;
    if (enabled) {
      await this.start().catch((error) => {
        logger.warn(`transcript-search: enabled startup failed: ${errorMessage(error)}`);
        this.#handleCrash(
          this.#lifecycleEpoch,
          error instanceof Error ? error : new Error(String(error)),
        );
      });
      return;
    }
    await this.disableAndDelete().catch(() => undefined);
  }

  async start(): Promise<void> {
    if (this.#worker && (this.#runtimeState === 'building' || this.#runtimeState === 'ready')) return;
    if (this.#runtimeState === 'disabled' || this.#runtimeState === 'stopping') {
      this.#restartAttempt = 0;
    }
    this.#desiredEnabled = true;
    this.#runtimeState = 'starting';
    this.#clearCleanupRetry();
    if (this.#requiresFreshIndex) {
      await deleteTranscriptSearchFiles(this.#deps.workspaceDir);
      this.#requiresFreshIndex = false;
    }
    await this.#deleteLegacyV2Files();
    const epoch = ++this.#lifecycleEpoch;
    const client = new TranscriptSearchWorkerClient(epoch, {
      workerFactory: this.#deps.workerFactory,
      onProgress: (progress) => this.#applyProgress(progress),
      onCrash: (error) => this.#handleCrash(epoch, error),
    });
    this.#worker = client;
    try {
      const generationFloor = await client.open(transcriptSearchDatabasePath(this.#deps.workspaceDir));
      this.#generationSeed = Math.max(this.#generationSeed, generationFloor);
      if (epoch !== this.#lifecycleEpoch || !this.#desiredEnabled) {
        await client.close();
        return;
      }
      this.#runtimeState = 'building';
      this.#scheduleRestartReset(epoch);
      this.#startReconcile(epoch);
    } catch (error) {
      if (this.#worker === client) this.#worker = null;
      await client.terminate();
      this.#runtimeState = 'degraded';
      throw error;
    }
  }

  async disableAndDelete(): Promise<void> {
    this.#desiredEnabled = false;
    this.#requiresFreshIndex = true;
    this.#runtimeState = 'stopping';
    ++this.#lifecycleEpoch;
    this.#clearWorkTimers();
    this.#clearRestartTimer();
    this.#clearRestartResetTimer();
    const worker = this.#worker;
    this.#worker = null;
    if (worker) await worker.close();
    try {
      await deleteTranscriptSearchFiles(this.#deps.workspaceDir);
      this.#requiresFreshIndex = false;
      this.#runtimeState = 'disabled';
      this.#progress = null;
      this.#clearCleanupRetry();
    } catch (error) {
      this.#runtimeState = 'degraded';
      logger.warn(`transcript-search: disabled cleanup failed: ${errorMessage(error)}`);
      this.#scheduleCleanupRetry();
      throw error;
    }
  }

  appendMessages(chatId: string, messages: ChatMessage[]): void {
    if (!this.#acceptsWork() || messages.length === 0) return;
    const availableRows = Math.max(0, MAX_QUEUED_ROWS - this.#queuedRows);
    const projected = projectLiveMessages(messages, availableRows);
    if (projected.requiresAuthoritativeReload) {
      this.markDirty(chatId);
      return;
    }
    const rows = projected.rows;
    if (rows.length === 0) return;
    const generation = this.#nextGeneration(chatId);
    if (this.#queuedRows + rows.length > MAX_QUEUED_ROWS) {
      this.#dropAppendBuffer(chatId);
      this.markDirty(chatId);
      return;
    }
    const buffer = this.#appendBuffers.get(chatId) ?? { rows: [], generation, timer: null };
    buffer.rows.push(...rows);
    buffer.generation = generation;
    this.#queuedRows += rows.length;
    this.#appendBuffers.set(chatId, buffer);
    if (buffer.rows.length >= APPEND_FLUSH_ROWS) {
      this.#flushAppend(chatId);
    } else if (!buffer.timer) {
      buffer.timer = setTimeout(() => this.#flushAppend(chatId), APPEND_FLUSH_MS);
      buffer.timer.unref?.();
    }
    this.#scheduleReseal(chatId);
  }

  markDirty(chatId: string): void {
    if (!this.#acceptsWork()) return;
    if (this.#dirtyRequests.has(chatId)) {
      this.#scheduleReseal(chatId, APPEND_FLUSH_MS);
      return;
    }
    const generation = this.#nextGeneration(chatId);
    this.#dirtyRequests.add(chatId);
    void this.#worker?.request({ type: 'mark-dirty', chatId, generation })
      .catch((error) => {
        logger.warn(`transcript-search: mark dirty failed for ${chatId}: ${errorMessage(error)}`);
      })
      .finally(() => this.#dirtyRequests.delete(chatId));
    this.#scheduleReseal(chatId, APPEND_FLUSH_MS);
  }

  deleteChat(chatId: string): void {
    this.#dropAppendBuffer(chatId);
    this.#clearResealTimer(chatId);
    const generation = this.#nextGeneration(chatId);
    this.#chatSources.delete(chatId);
    this.#clearSourceRetry(chatId);
    if (!this.#acceptsWork()) {
      if (this.#desiredEnabled) this.#pendingDeletes.add(chatId);
      return;
    }
    void this.#worker?.request({ type: 'delete-chat', chatId, generation }).catch((error) => {
      logger.warn(`transcript-search: delete failed for ${chatId}: ${errorMessage(error)}`);
      if (this.#desiredEnabled) this.#pendingDeletes.add(chatId);
    });
  }

  async search(options: {
    query: string;
    textTokens?: string[];
    allowedChatIds: string[];
    limit?: number;
  }): Promise<{ results: ChatSearchResult[]; index: ChatSearchIndexStatus }> {
    if (!this.#desiredEnabled || this.#runtimeState === 'disabled' || this.#runtimeState === 'stopping') {
      throw new TranscriptSearchUnavailableError(
        'TRANSCRIPT_SEARCH_DISABLED',
        'Transcript search is disabled',
        false,
      );
    }
    const worker = this.#worker;
    if (!worker || this.#runtimeState === 'starting' || this.#runtimeState === 'degraded') {
      throw new TranscriptSearchUnavailableError(
        'SEARCH_INDEX_UNAVAILABLE',
        'Transcript search is starting or unavailable',
        true,
      );
    }
    if (this.#searchInFlight) {
      throw new TranscriptSearchUnavailableError(
        'SEARCH_INDEX_BUSY',
        'Transcript search is busy',
        true,
      );
    }
    try {
      const request = worker.request({ type: 'search', ...options });
      const tracked = request.then(() => undefined, () => undefined).finally(() => {
        if (this.#searchInFlight === tracked) this.#searchInFlight = null;
      });
      this.#searchInFlight = tracked;
      const response = await withPromiseTimeout(
        request,
        SEARCH_TIMEOUT_MS,
        'Transcript search',
      );
      if (response.type !== 'search-result') throw new Error('Unexpected transcript search response');
      return { results: response.results, index: response.index };
    } catch (error) {
      if (error instanceof TranscriptSearchUnavailableError) throw error;
      if (error instanceof Error && error.name === 'PromiseTimeoutError') {
        throw new TranscriptSearchUnavailableError(
          'SEARCH_INDEX_BUSY',
          'Transcript search is busy',
          true,
        );
      }
      throw new TranscriptSearchUnavailableError(
        'SEARCH_INDEX_UNAVAILABLE',
        errorMessage(error),
        true,
      );
    }
  }

  async close(): Promise<void> {
    this.#desiredEnabled = false;
    ++this.#lifecycleEpoch;
    this.#clearCleanupRetry();
    this.#clearWorkTimers();
    this.#clearRestartTimer();
    this.#clearRestartResetTimer();
    const worker = this.#worker;
    this.#worker = null;
    if (worker) await worker.close();
    if (this.#runtimeState !== 'disabled') this.#runtimeState = 'disabled';
  }

  #acceptsWork(): boolean {
    return this.#desiredEnabled
      && Boolean(this.#worker)
      && (this.#runtimeState === 'building' || this.#runtimeState === 'ready');
  }

  #nextGeneration(chatId: string): number {
    const generation = Math.max((this.#generationByChat.get(chatId) ?? 0) + 1, ++this.#generationSeed);
    this.#generationByChat.set(chatId, generation);
    return generation;
  }

  #applyProgress(progress: TranscriptSearchProgressEvent): void {
    if (progress.lifecycleEpoch !== this.#lifecycleEpoch || !this.#desiredEnabled) return;
    this.#progress = progress;
    this.#runtimeState = progress.phase === 'ready' ? 'ready' : 'building';
  }

  #startReconcile(epoch: number): void {
    const task = this.#reconcile(epoch);
    this.#reconcileTask = task;
    void task.then(undefined, (error) => {
      logger.warn(`transcript-search: reconciliation failed: ${errorMessage(error)}`);
      this.#handleCrash(
        epoch,
        error instanceof Error ? error : new Error(String(error)),
      );
    }).finally(() => {
      if (this.#reconcileTask === task) this.#reconcileTask = null;
    });
  }

  async #reconcile(epoch: number): Promise<void> {
    const chats = this.#deps.listChats().sort((left, right) =>
      (right.lastActivityAt ?? '').localeCompare(left.lastActivityAt ?? ''),
    );
    this.#chatSources.clear();
    for (const chat of chats) this.#chatSources.set(chat.chatId, chat);
    const worker = this.#worker;
    if (!worker || epoch !== this.#lifecycleEpoch) return;
    await worker.request({
      type: 'prune-chats',
      registeredChatIds: chats.map((chat) => chat.chatId),
    });
    await this.#flushPendingDeletes();
    const deferredReleases: Array<() => void | Promise<void>> = [];
    try {
      for (const chat of chats) {
        if (epoch !== this.#lifecycleEpoch || !this.#acceptsWork()) return;
        if (this.#pendingDeletes.has(chat.chatId) || !this.#chatSources.has(chat.chatId)) continue;
        await this.#rebuildChat(chat, epoch, (release) => deferredReleases.push(release));
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    } finally {
      await Promise.allSettled(deferredReleases.map((release) => release()));
    }
  }

  async #rebuildChat(
    chat: TranscriptSearchChatSource,
    epoch: number,
    deferRelease?: (release: () => void | Promise<void>) => void,
  ): Promise<void> {
    const generation = this.#nextGeneration(chat.chatId);
    let plan: SearchTranscriptLoadPlan;
    try {
      plan = await this.#deps.resolveSearchLoadPlan(chat.chatId);
    } catch (error) {
      logger.warn(`transcript-search: source resolution failed for ${chat.chatId}: ${errorMessage(error)}`);
      await this.#worker?.request({
        type: 'mark-failed',
        chatId: chat.chatId,
        generation,
        reasonCode: 'source-unavailable',
      }).catch(() => undefined);
      this.#scheduleSourceRetry(chat.chatId);
      return;
    }
    if (epoch !== this.#lifecycleEpoch
        || !this.#worker
        || !this.#chatSources.has(chat.chatId)
        || this.#pendingDeletes.has(chat.chatId)) {
      if (plan.kind === 'detached') await plan.release?.();
      return;
    }
    if (plan.kind === 'live-only') {
      const retryable = plan.retryable === true;
      await this.#worker.request({
        type: retryable ? 'mark-failed' : 'mark-unsupported',
        chatId: chat.chatId,
        generation,
        reasonCode: plan.reasonCode,
      }).catch(() => undefined);
      if (retryable) this.#scheduleSourceRetry(chat.chatId);
      return;
    }
    try {
      if (epoch !== this.#lifecycleEpoch || !this.#worker) return;
      await this.#worker.request({
        type: 'rebuild-chat',
        chatId: chat.chatId,
        generation,
        buildSource: {
          source: plan.source,
          carryOver: this.#deps.getCarryOverDescriptor(chat.chatId) ?? undefined,
          currentAgentId: chat.agentId,
          currentModel: chat.model,
        },
      });
      this.#clearSourceRetry(chat.chatId);
    } catch (error) {
      logger.warn(`transcript-search: rebuild failed for ${chat.chatId}: ${errorMessage(error)}`);
      if (!(error instanceof TranscriptSearchWorkerError) || error.retryable) {
        this.#scheduleSourceRetry(chat.chatId);
      }
    } finally {
      if (plan.release && deferRelease) deferRelease(plan.release);
      else await plan.release?.();
    }
  }

  #flushAppend(chatId: string): void {
    const buffer = this.#appendBuffers.get(chatId);
    if (!buffer) return;
    this.#appendBuffers.delete(chatId);
    if (buffer.timer) clearTimeout(buffer.timer);
    if (!this.#acceptsWork()) {
      this.#queuedRows = Math.max(0, this.#queuedRows - buffer.rows.length);
      return;
    }
    void this.#worker?.request({
      type: 'append',
      chatId,
      generation: buffer.generation,
      rows: buffer.rows,
    }).catch((error) => {
      logger.warn(`transcript-search: append failed for ${chatId}: ${errorMessage(error)}`);
      this.markDirty(chatId);
    }).finally(() => {
      this.#queuedRows = Math.max(0, this.#queuedRows - buffer.rows.length);
    });
  }

  #dropAppendBuffer(chatId: string): void {
    const buffer = this.#appendBuffers.get(chatId);
    if (!buffer) return;
    if (buffer.timer) clearTimeout(buffer.timer);
    this.#queuedRows = Math.max(0, this.#queuedRows - buffer.rows.length);
    this.#appendBuffers.delete(chatId);
  }

  #scheduleReseal(chatId: string, delayMs = RESEAL_IDLE_MS): void {
    this.#clearResealTimer(chatId);
    const timer = setTimeout(() => {
      this.#resealTimers.delete(chatId);
      const chat = this.#chatSources.get(chatId)
        ?? this.#deps.listChats().find((entry) => entry.chatId === chatId);
      if (chat) this.#chatSources.set(chatId, chat);
      if (chat && this.#acceptsWork()) void this.#rebuildChat(chat, this.#lifecycleEpoch);
    }, delayMs);
    timer.unref?.();
    this.#resealTimers.set(chatId, timer);
  }

  #clearResealTimer(chatId: string): void {
    const timer = this.#resealTimers.get(chatId);
    if (timer) clearTimeout(timer);
    this.#resealTimers.delete(chatId);
  }

  #clearWorkTimers(): void {
    for (const buffer of this.#appendBuffers.values()) {
      if (buffer.timer) clearTimeout(buffer.timer);
    }
    for (const timer of this.#resealTimers.values()) clearTimeout(timer);
    for (const timer of this.#sourceRetryTimers.values()) clearTimeout(timer);
    this.#appendBuffers.clear();
    this.#resealTimers.clear();
    this.#sourceRetryTimers.clear();
    this.#sourceRetryAttempts.clear();
    this.#dirtyRequests.clear();
    this.#pendingDeletes.clear();
    this.#chatSources.clear();
    this.#queuedRows = 0;
  }

  async #flushPendingDeletes(): Promise<void> {
    const worker = this.#worker;
    if (!worker || !this.#acceptsWork()) return;
    for (const chatId of [...this.#pendingDeletes]) {
      const generation = this.#nextGeneration(chatId);
      try {
        await worker.request({ type: 'delete-chat', chatId, generation });
        this.#pendingDeletes.delete(chatId);
      } catch (error) {
        logger.warn(`transcript-search: deferred delete failed for ${chatId}: ${errorMessage(error)}`);
      }
    }
  }

  #scheduleSourceRetry(chatId: string): void {
    if (!this.#desiredEnabled || this.#sourceRetryTimers.has(chatId)) return;
    const attempt = this.#sourceRetryAttempts.get(chatId) ?? 0;
    const delay = SOURCE_RETRY_DELAYS_MS[attempt];
    if (delay === undefined) return;
    this.#sourceRetryAttempts.set(chatId, attempt + 1);
    const timer = setTimeout(() => {
      this.#sourceRetryTimers.delete(chatId);
      if (!this.#acceptsWork() || this.#pendingDeletes.has(chatId)) return;
      const chat = this.#chatSources.get(chatId)
        ?? this.#deps.listChats().find((entry) => entry.chatId === chatId);
      if (!chat) return;
      this.#chatSources.set(chatId, chat);
      void this.#rebuildChat(chat, this.#lifecycleEpoch);
    }, delay);
    timer.unref?.();
    this.#sourceRetryTimers.set(chatId, timer);
  }

  #clearSourceRetry(chatId: string): void {
    const timer = this.#sourceRetryTimers.get(chatId);
    if (timer) clearTimeout(timer);
    this.#sourceRetryTimers.delete(chatId);
    this.#sourceRetryAttempts.delete(chatId);
  }

  #handleCrash(epoch: number, error: Error): void {
    if (epoch !== this.#lifecycleEpoch || !this.#desiredEnabled) return;
    if (this.#restartTimer) return;
    logger.warn(`transcript-search: worker crashed: ${error.message}`);
    this.#runtimeState = 'degraded';
    this.#clearRestartResetTimer();
    const crashedWorker = this.#worker;
    this.#worker = null;
    void crashedWorker?.terminate();
    const delay = RESTART_DELAYS_MS[this.#restartAttempt];
    if (delay === undefined) return;
    this.#restartAttempt += 1;
    const timer = setTimeout(() => {
      this.#restartTimer = null;
      if (epoch !== this.#lifecycleEpoch || !this.#desiredEnabled) return;
      void this.start().catch((restartError) => {
        this.#handleCrash(this.#lifecycleEpoch, restartError instanceof Error
          ? restartError
          : new Error(String(restartError)));
      });
    }, delay);
    timer.unref?.();
    this.#restartTimer = timer;
  }

  #clearRestartTimer(): void {
    if (this.#restartTimer) clearTimeout(this.#restartTimer);
    this.#restartTimer = null;
  }

  #scheduleRestartReset(epoch: number): void {
    this.#clearRestartResetTimer();
    if (this.#restartAttempt === 0) return;
    const timer = setTimeout(() => {
      this.#restartResetTimer = null;
      if (epoch === this.#lifecycleEpoch && this.#desiredEnabled && this.#worker) {
        this.#restartAttempt = 0;
      }
    }, RESTART_STABLE_MS);
    timer.unref?.();
    this.#restartResetTimer = timer;
  }

  #clearRestartResetTimer(): void {
    if (this.#restartResetTimer) clearTimeout(this.#restartResetTimer);
    this.#restartResetTimer = null;
  }

  async #deleteLegacyV2Files(): Promise<void> {
    const legacy = path.join(this.#deps.workspaceDir, 'chat-search.sqlite');
    await Promise.all([legacy, `${legacy}-wal`, `${legacy}-shm`].map((filePath) => fs.rm(filePath, { force: true })));
  }

  #scheduleCleanupRetry(): void {
    this.#clearCleanupRetry();
    const timer = setTimeout(() => {
      this.#cleanupRetryTimer = null;
      if (this.#desiredEnabled) return;
      void deleteTranscriptSearchFiles(this.#deps.workspaceDir).then(() => {
        if (!this.#desiredEnabled) this.#runtimeState = 'disabled';
      }).catch((error) => {
        logger.warn(`transcript-search: cleanup retry failed: ${errorMessage(error)}`);
        this.#scheduleCleanupRetry();
      });
    }, this.#deps.cleanupRetryMs ?? 30_000);
    timer.unref?.();
    this.#cleanupRetryTimer = timer;
  }

  #clearCleanupRetry(): void {
    if (this.#cleanupRetryTimer) clearTimeout(this.#cleanupRetryTimer);
    this.#cleanupRetryTimer = null;
  }
}
