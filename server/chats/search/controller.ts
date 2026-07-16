import { promises as fs } from 'fs';
import path from 'path';
import type { ChatMessage } from '../../../common/chat-types.js';
import type { ChatSearchIndexStatus, ChatSearchResult } from '../../../common/chat-search.js';
import { errorMessage } from '../../lib/errors.js';
import { createLogger } from '../../lib/log.js';
import { withPromiseTimeout } from '../../lib/promise-timeout.js';
import { projectSearchMessages } from './message-projector.js';
import {
  deleteTranscriptSearchFiles,
  transcriptSearchDatabasePath,
} from './file-cleanup.js';
import type { SearchTranscriptLoadPlan, TranscriptBuildSource } from './source-types.js';
import { TranscriptSearchWorkerClient } from './worker-client.js';
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
  #worker: TranscriptSearchWorkerClient | null = null;
  #runtimeState: TranscriptSearchRuntimeState = 'disabled';
  #progress: TranscriptSearchProgressEvent | null = null;
  #lifecycleEpoch = 0;
  #generationSeed = Date.now() * 1_000;
  #queuedRows = 0;
  #desiredEnabled = false;
  #cleanupRetryTimer: ReturnType<typeof setTimeout> | null = null;
  #restartAttempt = 0;
  #reconcileTask: Promise<void> | null = null;

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
    await this.#deleteLegacyV2Files();
    const epoch = ++this.#lifecycleEpoch;
    const client = new TranscriptSearchWorkerClient(epoch, {
      workerFactory: this.#deps.workerFactory,
      onProgress: (progress) => this.#applyProgress(progress),
      onCrash: (error) => this.#handleCrash(epoch, error),
    });
    this.#worker = client;
    try {
      await client.open(transcriptSearchDatabasePath(this.#deps.workspaceDir));
      if (epoch !== this.#lifecycleEpoch || !this.#desiredEnabled) {
        await client.close();
        return;
      }
      this.#runtimeState = 'building';
      this.#startReconcile(epoch);
    } catch (error) {
      if (this.#worker === client) this.#worker = null;
      client.terminate();
      this.#runtimeState = 'degraded';
      throw error;
    }
  }

  async disableAndDelete(): Promise<void> {
    this.#desiredEnabled = false;
    this.#runtimeState = 'stopping';
    ++this.#lifecycleEpoch;
    this.#clearWorkTimers();
    const worker = this.#worker;
    this.#worker = null;
    if (worker) await worker.close();
    try {
      await deleteTranscriptSearchFiles(this.#deps.workspaceDir);
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
    const rows = projectSearchMessages(messages);
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
    const generation = this.#nextGeneration(chatId);
    void this.#worker?.request({ type: 'mark-dirty', chatId, generation }).catch((error) => {
      logger.warn(`transcript-search: mark dirty failed for ${chatId}: ${errorMessage(error)}`);
    });
    this.#scheduleReseal(chatId, APPEND_FLUSH_MS);
  }

  deleteChat(chatId: string): void {
    this.#dropAppendBuffer(chatId);
    this.#clearResealTimer(chatId);
    const generation = this.#nextGeneration(chatId);
    if (!this.#acceptsWork()) return;
    void this.#worker?.request({ type: 'delete-chat', chatId, generation }).catch((error) => {
      logger.warn(`transcript-search: delete failed for ${chatId}: ${errorMessage(error)}`);
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
    try {
      const response = await withPromiseTimeout(
        worker.request({ type: 'search', ...options }),
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
    void task.finally(() => {
      if (this.#reconcileTask === task) this.#reconcileTask = null;
    });
  }

  async #reconcile(epoch: number): Promise<void> {
    const chats = this.#deps.listChats().sort((left, right) =>
      (right.lastActivityAt ?? '').localeCompare(left.lastActivityAt ?? ''),
    );
    for (const chat of chats) {
      if (epoch !== this.#lifecycleEpoch || !this.#acceptsWork()) return;
      await this.#rebuildChat(chat, epoch);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }

  async #rebuildChat(chat: TranscriptSearchChatSource, epoch: number): Promise<void> {
    let plan: SearchTranscriptLoadPlan;
    try {
      plan = await this.#deps.resolveSearchLoadPlan(chat.chatId);
    } catch (error) {
      logger.warn(`transcript-search: source resolution failed for ${chat.chatId}: ${errorMessage(error)}`);
      return;
    }
    const generation = this.#nextGeneration(chat.chatId);
    if (plan.kind === 'live-only') {
      await this.#worker?.request({
        type: 'mark-unsupported',
        chatId: chat.chatId,
        generation,
        reasonCode: plan.reasonCode,
      }).catch(() => undefined);
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
    } catch (error) {
      logger.warn(`transcript-search: rebuild failed for ${chat.chatId}: ${errorMessage(error)}`);
    } finally {
      await plan.release?.();
    }
  }

  #flushAppend(chatId: string): void {
    const buffer = this.#appendBuffers.get(chatId);
    if (!buffer) return;
    this.#appendBuffers.delete(chatId);
    if (buffer.timer) clearTimeout(buffer.timer);
    this.#queuedRows = Math.max(0, this.#queuedRows - buffer.rows.length);
    if (!this.#acceptsWork()) return;
    void this.#worker?.request({
      type: 'append',
      chatId,
      generation: buffer.generation,
      rows: buffer.rows,
    }).catch((error) => {
      logger.warn(`transcript-search: append failed for ${chatId}: ${errorMessage(error)}`);
      this.markDirty(chatId);
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
      const chat = this.#deps.listChats().find((entry) => entry.chatId === chatId);
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
    this.#appendBuffers.clear();
    this.#resealTimers.clear();
    this.#queuedRows = 0;
  }

  #handleCrash(epoch: number, error: Error): void {
    if (epoch !== this.#lifecycleEpoch || !this.#desiredEnabled) return;
    logger.warn(`transcript-search: worker crashed: ${error.message}`);
    this.#runtimeState = 'degraded';
    this.#worker = null;
    const delay = RESTART_DELAYS_MS[this.#restartAttempt];
    if (delay === undefined) return;
    this.#restartAttempt += 1;
    const timer = setTimeout(() => {
      if (epoch !== this.#lifecycleEpoch || !this.#desiredEnabled) return;
      void this.start().catch((restartError) => {
        this.#handleCrash(this.#lifecycleEpoch, restartError instanceof Error
          ? restartError
          : new Error(String(restartError)));
      });
    }, delay);
    timer.unref?.();
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
