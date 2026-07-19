import crypto from 'node:crypto';
import type {
  AgentChatReference,
  AgentSearchHit,
  AgentSearchChat,
  AgentSearchGeneration,
} from '@garcon/server-agent-interface';
import type { IntegrationRegistry } from '../../agents/integration-registry.js';
import type {
  ChatSearchIndexStatus,
  ChatSearchPartialFailure,
  ChatSearchQueryV1,
  ChatSearchResult,
} from '@garcon/common/chat-search';
import { CHAT_SEARCH_MIN_PREFIX_CHARS } from '@garcon/common/chat-search';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const DEFAULT_SEARCH_TIMEOUT_MS = 5_000;
const RECONCILE_DELAY_MS = 100;

export class TranscriptSearchUnavailableError extends Error {
  constructor(
    readonly code: 'TRANSCRIPT_SEARCH_DISABLED' | 'SEARCH_INDEX_UNAVAILABLE' | 'SEARCH_INDEX_BUSY',
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'TranscriptSearchUnavailableError';
  }
}

export interface TranscriptSearchChatRegistration {
  readonly agentId: string;
  readonly reference: AgentChatReference;
  readonly updatedAt: string | null;
}

export interface TranscriptSearchControllerDeps {
  readonly integrations: IntegrationRegistry;
  readonly listChats: () => readonly TranscriptSearchChatRegistration[];
  readonly searchTimeoutMs?: number;
}

interface AgentSearchScope {
  readonly agentId: string;
  readonly chats: readonly AgentSearchChat[];
}

export class TranscriptSearchController {
  readonly #deps: TranscriptSearchControllerDeps;
  readonly #epoch = crypto.randomUUID();
  #sequence = 0;
  #enabled = false;
  #closed = false;
  #reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  #reconcileAbort: AbortController | null = null;
  #reconcilePromise: Promise<void> = Promise.resolve();
  #indexedScopes = new Map<string, AgentSearchScope>();

  constructor(deps: TranscriptSearchControllerDeps) {
    this.#deps = deps;
  }

  async initialize(enabled: boolean): Promise<void> {
    if (enabled) {
      await this.start();
      return;
    }
    await this.disableAndDelete();
  }

  async start(): Promise<void> {
    if (this.#closed) throw new Error('Transcript search controller is closed');
    this.#enabled = true;
    await this.#reconcileNow();
  }

  appendMessages(chatId: string): void {
    this.markDirty(chatId);
  }

  markDirty(_chatId: string): void {
    if (!this.#enabled || this.#closed || this.#reconcileTimer) return;
    this.#reconcileTimer = setTimeout(() => {
      this.#reconcileTimer = null;
      void this.#reconcileNow();
    }, RECONCILE_DELAY_MS);
    this.#reconcileTimer.unref?.();
  }

  deleteChat(chatId: string): void {
    for (const scope of this.#indexedScopes.values()) {
      if (scope.chats.some((chat) => chat.chatId === chatId)) {
        this.markDirty(chatId);
        break;
      }
    }
  }

  async search(options: {
    readonly query: string;
    readonly textTokens?: string[];
    readonly allowedChatIds: string[];
    readonly limit?: number;
  }): Promise<{
    results: ChatSearchResult[];
    index: ChatSearchIndexStatus;
    partialFailures?: ChatSearchPartialFailure[];
  }> {
    if (!this.#enabled) {
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

    const allowed = new Set(options.allowedChatIds);
    const limit = clampLimit(options.limit);
    const query = compileQuery(options.query, options.textTokens);
    const scopes = [...this.#indexedScopes.values()]
      .map((scope) => ({ ...scope, chats: scope.chats.filter((chat) => allowed.has(chat.chatId)) }))
      .filter((scope) => scope.chats.length > 0)
      .sort((left, right) => left.agentId.localeCompare(right.agentId));
    const settled = await Promise.all(scopes.map((scope) => this.#searchScope(scope, query, limit)));
    const partialFailures: ChatSearchPartialFailure[] = [];
    const successful: Array<{
      agentId: string;
      hits: readonly AgentSearchHit[];
      index: ChatSearchIndexStatus;
    }> = [];

    for (const result of settled) {
      if ('failure' in result) partialFailures.push(result.failure);
      else successful.push(result);
    }

    const results = interleaveRanks(successful, allowed, limit);
    const index = successful.reduce((total, result) => addStatus(total, result.index), emptyStatus());
    return {
      results,
      index,
      ...(partialFailures.length > 0 ? { partialFailures } : {}),
    };
  }

  async disableAndDelete(): Promise<void> {
    this.#enabled = false;
    this.#cancelScheduledReconcile();
    const generation = this.#nextGeneration();
    const settled = await Promise.allSettled(this.#deps.integrations.list().map((integration) => {
      const abort = new AbortController();
      return integration.transcriptSearch.disableAndDelete({ generation, signal: abort.signal });
    }));
    this.#indexedScopes.clear();
    const failures = settled
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    if (failures.length > 0) throw new AggregateError(failures, 'Transcript search cleanup failed');
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#enabled = false;
    this.#cancelScheduledReconcile();
    await this.#reconcilePromise.catch(() => undefined);
  }

  async #reconcileNow(): Promise<void> {
    if (!this.#enabled || this.#closed) return;
    const previous = this.#reconcileAbort;
    const abort = new AbortController();
    this.#reconcileAbort = abort;
    previous?.abort();
    const generation = this.#nextGeneration();
    const work = this.#buildScopes(abort.signal).then(async (scopes) => {
      if (abort.signal.aborted || !this.#enabled || this.#closed) return;
      const byAgent = new Map(scopes.map((scope) => [scope.agentId, scope]));
      const settled = await Promise.allSettled(this.#deps.integrations.list().map((integration) => (
        integration.transcriptSearch.reconcile({
          chats: byAgent.get(integration.descriptor.id)?.chats ?? [],
          generation,
          signal: abort.signal,
        })
      )));
      if (abort.signal.aborted || !this.#enabled || this.#closed) return;
      const failures = settled.filter((result) => result.status === 'rejected');
      if (failures.length === settled.length && settled.length > 0) {
        throw new AggregateError(
          failures.map((result) => (result as PromiseRejectedResult).reason),
          'Every agent transcript index failed to reconcile',
        );
      }
      this.#indexedScopes = byAgent;
    });
    this.#reconcilePromise = work;
    try {
      await work;
    } finally {
      if (this.#reconcileAbort === abort) this.#reconcileAbort = null;
    }
  }

  async #buildScopes(signal: AbortSignal): Promise<AgentSearchScope[]> {
    const registrations = this.#deps.listChats();
    const byAgent = new Map<string, AgentSearchChat[]>();
    await Promise.all(registrations.map(async (registration) => {
      signal.throwIfAborted();
      const integration = this.#deps.integrations.get(registration.agentId);
      if (!integration) return;
      let transcriptRevision: string;
      try {
        transcriptRevision = await integration.transcript.revision({
          chat: registration.reference,
          signal,
        });
      } catch {
        transcriptRevision = `unavailable:${registration.updatedAt ?? ''}`;
      }
      const chats = byAgent.get(registration.agentId) ?? [];
      chats.push({
        chatId: registration.reference.chatId,
        projectPath: registration.reference.projectPath,
        model: registration.reference.model,
        nativeSession: registration.reference.nativeSession,
        updatedAt: registration.updatedAt,
        carryOverRevision: registration.reference.carryOverRevision,
        transcriptRevision,
      });
      byAgent.set(registration.agentId, chats);
    }));
    return [...byAgent.entries()].map(([agentId, chats]) => ({
      agentId,
      chats: chats.sort((left, right) => left.chatId.localeCompare(right.chatId)),
    }));
  }

  async #searchScope(scope: AgentSearchScope, query: ChatSearchQueryV1, limit: number): Promise<
    | { agentId: string; hits: readonly AgentSearchHit[]; index: ChatSearchIndexStatus }
    | { failure: ChatSearchPartialFailure }
  > {
    const integration = this.#deps.integrations.require(scope.agentId);
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), this.#deps.searchTimeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS);
    timeout.unref?.();
    try {
      const response = await integration.transcriptSearch.search({
        query,
        chats: scope.chats,
        limit,
        signal: abort.signal,
      });
      const allowed = new Set(scope.chats.map((chat) => chat.chatId));
      if (response.hits.some((hit) => !allowed.has(hit.chatId))) {
        return { failure: failure(scope, 'INVALID_RESPONSE', false) };
      }
      return { agentId: scope.agentId, hits: response.hits, index: response.index };
    } catch (error) {
      return {
        failure: failure(
          scope,
          abort.signal.aborted ? 'SEARCH_TIMEOUT' : 'SEARCH_UNAVAILABLE',
          abort.signal.aborted || isRetryable(error),
        ),
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  #cancelScheduledReconcile(): void {
    if (this.#reconcileTimer) clearTimeout(this.#reconcileTimer);
    this.#reconcileTimer = null;
    this.#reconcileAbort?.abort();
    this.#reconcileAbort = null;
  }

  #nextGeneration(): AgentSearchGeneration {
    return { epoch: this.#epoch, sequence: ++this.#sequence };
  }
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
    clauses: raw.map((term) => {
      const words = term.text.match(/[\p{L}\p{N}_]+/gu) ?? [];
      return {
        kind: term.phrase ? 'phrase' as const : 'all-words' as const,
        tokens: words.map((text) => ({
          text,
          normalized: text.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase(),
          match: !term.phrase && [...text].length >= CHAT_SEARCH_MIN_PREFIX_CHARS
            ? 'prefix' as const
            : 'exact' as const,
        })),
      };
    }).filter((clause) => clause.tokens.length > 0),
  };
}

function interleaveRanks(
  sources: readonly { agentId: string; hits: readonly { chatId: string; matchedMessageCount: number; snippets: readonly ChatSearchResult['snippets'][number][] }[] }[],
  allowed: ReadonlySet<string>,
  limit: number,
): ChatSearchResult[] {
  const merged: ChatSearchResult[] = [];
  const seen = new Set<string>();
  for (let rank = 0; merged.length < limit; rank += 1) {
    let found = false;
    for (const source of sources) {
      const hit = source.hits[rank];
      if (!hit) continue;
      found = true;
      if (!allowed.has(hit.chatId) || seen.has(hit.chatId)) continue;
      seen.add(hit.chatId);
      merged.push({
        chatId: hit.chatId,
        score: 1 / (merged.length + 1),
        matchedMessageCount: hit.matchedMessageCount,
        snippets: [...hit.snippets],
      });
      if (merged.length >= limit) break;
    }
    if (!found) break;
  }
  return merged;
}

function failure(
  scope: AgentSearchScope,
  code: ChatSearchPartialFailure['code'],
  retryable: boolean,
): ChatSearchPartialFailure {
  return { agentId: scope.agentId, code, retryable, eligibleChatCount: scope.chats.length };
}

function isRetryable(error: unknown): boolean {
  return error !== null
    && typeof error === 'object'
    && 'retryable' in error
    && error.retryable === true;
}

function clampLimit(limit: number | undefined): number {
  return Number.isInteger(limit) ? Math.min(MAX_LIMIT, Math.max(1, Number(limit))) : DEFAULT_LIMIT;
}

function emptyStatus(): ChatSearchIndexStatus {
  return { indexedChatCount: 0, pendingChatCount: 0, failedChatCount: 0, unsupportedChatCount: 0 };
}

function addStatus(left: ChatSearchIndexStatus, right: ChatSearchIndexStatus): ChatSearchIndexStatus {
  return {
    indexedChatCount: left.indexedChatCount + right.indexedChatCount,
    pendingChatCount: left.pendingChatCount + right.pendingChatCount,
    failedChatCount: left.failedChatCount + right.failedChatCount,
    unsupportedChatCount: left.unsupportedChatCount + right.unsupportedChatCount,
  };
}
