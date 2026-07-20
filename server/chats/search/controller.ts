import type { AgentChatReference, AgentTranscriptIndexSourceRef } from '@garcon/server-agent-interface';
import type { ChatSearchIndexStatus, ChatSearchQueryV1, ChatSearchResult } from '@garcon/common/chat-search';
import { CHAT_SEARCH_MIN_PREFIX_CHARS } from '@garcon/common/chat-search';
import type { IntegrationRegistry } from '../../agents/integration-registry.js';
import type {
  TranscriptSearchCatalogEntry,
  TranscriptSearchGeneration,
  TranscriptSearchService,
  TranscriptSearchSourceRefreshRequest,
} from '@garcon/server-agent-common/search/transcript-search-service';
import { TranscriptSearchUnavailableError } from './errors.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const DEFAULT_SEARCH_TIMEOUT_MS = 5_000;
const RECONCILE_DELAY_MS = 100;
const SOURCE_RESOLUTION_CONCURRENCY = 8;
const RECONCILE_RETRY_MS = [5_000, 30_000, 5 * 60_000] as const;

export interface TranscriptSearchChatRegistration {
  readonly agentId: string;
  readonly reference: AgentChatReference;
  readonly updatedAt: string | null;
}

export interface TranscriptSearchControllerDeps {
  readonly integrations: IntegrationRegistry;
  readonly listChats: () => readonly TranscriptSearchChatRegistration[];
  readonly service: TranscriptSearchService;
  readonly searchTimeoutMs?: number;
}

export class TranscriptSearchController {
  readonly #deps: TranscriptSearchControllerDeps;
  readonly #epoch: string;
  readonly #lifecycleAbort = new AbortController();
  #sequence = 0;
  #enabled = false;
  #admissionFailed = false;
  #closed = false;
  #reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  #reconcileAbort: AbortController | null = null;
  readonly #reconcileTasks = new Set<Promise<void>>();
  #reconcileRetryAttempt = 0;
  #catalogEntries = new Map<string, TranscriptSearchCatalogEntry>();

  constructor(deps: TranscriptSearchControllerDeps) {
    this.#deps = deps;
    this.#epoch = deps.service.operationEpoch();
    deps.service.setSourceRefreshHandler((request) => this.#refreshIndexSource(request));
    deps.service.setCatalogRefreshHandler((chatId) => this.catalogMayHaveChanged(chatId));
  }

  async initialize(enabled: boolean): Promise<void> {
    if (enabled) await this.start();
    else await this.disableAndDelete();
  }

  async start(): Promise<void> {
    if (this.#closed) throw new Error('Transcript search controller is closed');
    if (this.#enabled) return;
    try {
      await this.#deps.service.enable({
        modules: this.#deps.integrations.classes().map((integrationClass) => ({
          agentId: integrationClass.integrationId,
          reference: integrationClass.transcriptIndex,
        })),
        signal: this.#lifecycleAbort.signal,
      });
      this.#lifecycleAbort.signal.throwIfAborted();
      this.#enabled = true;
      this.#admissionFailed = false;
      this.#scheduleCatalogReconcile(0);
    } catch (error) {
      this.#enabled = false;
      this.#admissionFailed = true;
      throw error;
    }
  }

  sourceMayHaveChanged(chatId: string): void {
    if (!this.#enabled || this.#closed) return;
    const known = this.#deps.listChats().some((entry) => entry.reference.chatId === chatId);
    if (!known) return;
    this.#deps.service.sourceMayHaveChanged({ chatId, generation: this.#nextGeneration() });
    if (this.#catalogEntries.get(chatId)?.source.state !== 'ready') {
      this.#scheduleCatalogReconcile();
    }
  }

  markDirty(chatId: string): void {
    this.sourceMayHaveChanged(chatId);
  }

  catalogMayHaveChanged(chatId?: string): void {
    if (!this.#enabled || this.#closed) return;
    if (chatId && !this.#deps.listChats().some((entry) => entry.reference.chatId === chatId)) return;
    this.#scheduleCatalogReconcile();
  }

  deleteChat(chatId: string): void {
    if (!this.#enabled || this.#closed) return;
    this.#deps.service.deleteChat({ chatId, generation: this.#nextGeneration() });
    this.#catalogEntries.delete(chatId);
    this.#scheduleCatalogReconcile();
  }

  async search(options: {
    readonly query: string;
    readonly textTokens?: string[];
    readonly allowedChatIds: string[];
    readonly limit?: number;
  }): Promise<{ results: ChatSearchResult[]; index: ChatSearchIndexStatus }> {
    if (!this.#enabled) {
      if (this.#admissionFailed) {
        throw new TranscriptSearchUnavailableError(
          'SEARCH_INDEX_UNAVAILABLE',
          'Transcript search is unavailable',
          true,
        );
      }
      throw new TranscriptSearchUnavailableError(
        'TRANSCRIPT_SEARCH_DISABLED',
        'Transcript search is disabled',
        false,
      );
    }
    if (this.#closed) {
      throw new TranscriptSearchUnavailableError(
        'SEARCH_INDEX_UNAVAILABLE',
        'Transcript search is unavailable',
        true,
      );
    }
    const abort = new AbortController();
    const timeout = setTimeout(
      () => abort.abort(),
      this.#deps.searchTimeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS,
    );
    timeout.unref?.();
    try {
      const allowed = new Set(options.allowedChatIds);
      const response = await this.#deps.service.search({
        query: compileQuery(options.query, options.textTokens),
        allowedChatIds: options.allowedChatIds,
        limit: clampLimit(options.limit),
        signal: abort.signal,
      });
      return {
        results: response.results.filter((result) => allowed.has(result.chatId)),
        index: response.index,
      };
    } catch (error) {
      throw new TranscriptSearchUnavailableError(
        abort.signal.aborted ? 'SEARCH_INDEX_BUSY' : 'SEARCH_INDEX_UNAVAILABLE',
        abort.signal.aborted ? 'Transcript search is busy' : 'Transcript search is unavailable',
        true,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  async disableAndDelete(): Promise<void> {
    this.#enabled = false;
    this.#admissionFailed = false;
    this.#cancelScheduledReconcile();
    await Promise.allSettled(this.#reconcileTasks);
    await this.#deps.service.disableAndDelete(new AbortController().signal);
    this.#catalogEntries.clear();
    this.#reconcileRetryAttempt = 0;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#enabled = false;
    this.#lifecycleAbort.abort();
    this.#cancelScheduledReconcile();
    await Promise.allSettled(this.#reconcileTasks);
    await this.#deps.service.close();
  }

  #scheduleCatalogReconcile(delayMs = RECONCILE_DELAY_MS): void {
    if (!this.#enabled || this.#closed) return;
    if (this.#reconcileTimer) clearTimeout(this.#reconcileTimer);
    this.#reconcileTimer = setTimeout(() => {
      this.#reconcileTimer = null;
      void this.#reconcileNow();
    }, delayMs);
    this.#reconcileTimer.unref?.();
  }

  async #reconcileNow(): Promise<void> {
    if (!this.#enabled || this.#closed) return;
    const previous = this.#reconcileAbort;
    const abort = new AbortController();
    this.#reconcileAbort = abort;
    previous?.abort();
    const generation = this.#nextGeneration();
    const work = this.#buildCatalog(generation, abort.signal).then(async (chats) => {
      if (abort.signal.aborted || !this.#enabled || this.#closed) return;
      await this.#deps.service.reconcile({ generation, chats });
      this.#catalogEntries = new Map(chats.map((entry) => [entry.chatId, entry]));
      if (chats.some((entry) => entry.source.state === 'failed' && entry.source.retryable)) {
        this.#scheduleCatalogReconcile(this.#nextReconcileRetryDelay());
      } else {
        this.#reconcileRetryAttempt = 0;
      }
    });
    this.#reconcileTasks.add(work);
    try {
      await work;
    } catch (error) {
      if (!abort.signal.aborted && this.#enabled && !this.#closed) {
        this.#scheduleCatalogReconcile(this.#nextReconcileRetryDelay());
      }
    } finally {
      this.#reconcileTasks.delete(work);
      if (this.#reconcileAbort === abort) this.#reconcileAbort = null;
    }
  }

  async #buildCatalog(
    _generation: TranscriptSearchGeneration,
    signal: AbortSignal,
  ): Promise<TranscriptSearchCatalogEntry[]> {
    const registrations = [...this.#deps.listChats()];
    const results = new Array<TranscriptSearchCatalogEntry>(registrations.length);
    let cursor = 0;
    const workers = Array.from(
      { length: Math.min(SOURCE_RESOLUTION_CONCURRENCY, registrations.length) },
      async () => {
        while (cursor < registrations.length) {
          const index = cursor++;
          const registration = registrations[index];
          signal.throwIfAborted();
          results[index] = await this.#resolveCatalogEntry(registration, signal);
        }
      },
    );
    await Promise.all(workers);
    return results.sort((left, right) => left.chatId.localeCompare(right.chatId));
  }

  async #resolveCatalogEntry(
    registration: TranscriptSearchChatRegistration,
    signal: AbortSignal,
  ): Promise<TranscriptSearchCatalogEntry> {
    const integration = this.#deps.integrations.get(registration.agentId);
    let source: TranscriptSearchCatalogEntry['source'];
    if (!integration) {
      source = { state: 'failed', code: 'INTEGRATION_UNAVAILABLE', retryable: false };
    } else {
      try {
        const reference = await integration.transcript.resolveIndexSource({
          chat: registration.reference,
          signal,
        });
        if (!reference) source = { state: 'absent' };
        else {
          validateIndexSource(reference, registration.agentId);
          source = { state: 'ready', reference };
        }
      } catch (error) {
        signal.throwIfAborted();
        const failure = sanitizeResolutionFailure(error);
        source = { state: 'failed', code: failure.code, retryable: failure.retryable };
      }
    }
    return {
      chatId: registration.reference.chatId,
      agentId: registration.agentId,
      model: registration.reference.model,
      updatedAt: registration.updatedAt,
      source,
      carryOverRevision: registration.reference.carryOverRevision,
    };
  }

  #cancelScheduledReconcile(): void {
    if (this.#reconcileTimer) clearTimeout(this.#reconcileTimer);
    this.#reconcileTimer = null;
    this.#reconcileAbort?.abort();
    this.#reconcileAbort = null;
  }

  #nextReconcileRetryDelay(): number {
    const delay = RECONCILE_RETRY_MS[Math.min(
      this.#reconcileRetryAttempt,
      RECONCILE_RETRY_MS.length - 1,
    )];
    this.#reconcileRetryAttempt += 1;
    return delay;
  }

  async #refreshIndexSource(request: TranscriptSearchSourceRefreshRequest): Promise<void> {
    if (!this.#enabled || this.#closed) return;
    const registration = this.#deps.listChats().find(
      (entry) => entry.reference.chatId === request.chatId && entry.agentId === request.agentId,
    );
    const integration = this.#deps.integrations.get(request.agentId);
    if (!registration || !integration) return;
    const signal = AbortSignal.any([request.signal, this.#lifecycleAbort.signal]);
    const reference = await integration.transcript.refreshIndexSource({
      chat: registration.reference,
      failedSource: request.failedSource,
      failureCode: request.failureCode,
      signal,
    });
    signal.throwIfAborted();
    if (reference) validateIndexSource(reference, request.agentId);
    this.#scheduleCatalogReconcile(0);
  }

  #nextGeneration(): TranscriptSearchGeneration {
    return { epoch: this.#epoch, sequence: ++this.#sequence };
  }
}

function validateIndexSource(reference: AgentTranscriptIndexSourceRef, agentId: string): void {
  if (reference.ownerId !== agentId
      || !Number.isSafeInteger(reference.schemaVersion)
      || reference.schemaVersion < 1
      || !reference.value
      || typeof reference.value !== 'object'
      || Array.isArray(reference.value)
      || !isJsonValue(reference.value, new Set())) {
    throw new Error('INVALID_INDEX_SOURCE');
  }
  if (Buffer.byteLength(JSON.stringify(reference)) > 64 * 1024) {
    throw new Error('INDEX_SOURCE_TOO_LARGE');
  }
}

function isJsonValue(value: unknown, ancestors: Set<object>): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (ancestors.has(value)) return false;
  if (!Array.isArray(value)) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
  }
  ancestors.add(value);
  const valid = Array.isArray(value)
    ? value.every((entry) => isJsonValue(entry, ancestors))
    : Object.values(value as Record<string, unknown>)
      .every((entry) => isJsonValue(entry, ancestors));
  ancestors.delete(value);
  return valid;
}

function sanitizeResolutionFailure(error: unknown): { code: string; retryable: boolean } {
  const failure = error && typeof error === 'object'
    ? (error as { failure?: { code?: unknown; retryable?: unknown } }).failure
    : null;
  if (typeof failure?.code === 'string'
      && /^[A-Z][A-Z0-9_]{0,63}$/.test(failure.code)
      && typeof failure.retryable === 'boolean') {
    return { code: failure.code, retryable: failure.retryable };
  }
  if (error instanceof Error && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.message)) {
    return { code: error.message, retryable: false };
  }
  return { code: 'SOURCE_RESOLUTION_INTERNAL', retryable: false };
}

function compileQuery(query: string, textTokens?: readonly string[]): ChatSearchQueryV1 {
  const quoted = new Map<string, number>();
  for (const match of query.matchAll(/"([^"]+)"|'([^']+)'/g)) {
    const value = (match[1] ?? match[2] ?? '').toLowerCase();
    quoted.set(value, (quoted.get(value) ?? 0) + 1);
  }
  const raw = textTokens?.length
    ? textTokens.map((text) => {
      const key = text.toLowerCase();
      const count = quoted.get(key) ?? 0;
      if (count > 0) quoted.set(key, count - 1);
      return { text, phrase: /\s/u.test(text) || count > 0 };
    })
    : [...query.matchAll(/"([^"]+)"|'([^']+)'|(\S+)/g)].map((match) => ({
      text: match[1] ?? match[2] ?? match[3] ?? '',
      phrase: match[1] !== undefined || match[2] !== undefined,
    }));
  return {
    version: 1,
    clauses: raw.map((term) => ({
      kind: term.phrase ? 'phrase' as const : 'all-words' as const,
      tokens: (term.text.match(/[\p{L}\p{N}_]+/gu) ?? []).map((text) => ({
        text,
        normalized: text.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase(),
        match: !term.phrase && [...text].length >= CHAT_SEARCH_MIN_PREFIX_CHARS
          ? 'prefix' as const
          : 'exact' as const,
      })),
    })).filter((clause) => clause.tokens.length > 0),
  };
}

function clampLimit(limit: number | undefined): number {
  return Number.isInteger(limit) ? Math.min(MAX_LIMIT, Math.max(1, Number(limit))) : DEFAULT_LIMIT;
}
