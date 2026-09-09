import type {
  ChatSearchNavigateRequest,
  ChatSearchNavigateResponse,
  ChatSearchRequest,
  ChatSearchResponse,
  ChatSearchResultMode,
  ChatSearchSort,
  TranscriptSearchQueryStatsV1,
  TranscriptSearchRebuildResponse,
  TranscriptSearchStatusResponse,
  TranscriptSearchStatusV1,
} from '../../common/chat-search.js';
import {
  CHAT_SEARCH_MAX_OFFSET,
  CHAT_SEARCH_MAX_CHAT_IDS,
  CHAT_SEARCH_MAX_PAGE_SIZE,
  CHAT_SEARCH_MAX_PREFIX_SIZE,
  CHAT_SEARCH_MAX_SNIPPETS_PER_CHAT,
  CHAT_SEARCH_RESULT_MODES,
  CHAT_SEARCH_MAX_TERMS,
  CHAT_SEARCH_MAX_WORDS,
  CHAT_SEARCH_SORT_VALUES,
} from '../../common/chat-search.js';
import type { ChatListEntry } from '../../common/chat-list.js';
import type { ChatOrderTimestamps } from '../../common/chat-order-sort.js';
import {
  chatActivityTimeMs,
  chatCreationTimeMs,
} from '../../common/chat-order-sort.js';
import type { ChatListProjector } from '../chats/chat-list-projector.js';
import { TranscriptSearchUnavailableError } from '../chats/search/errors.js';
import { TranscriptSearchSettingsError } from '../chats/search/settings-coordinator.js';
import type { IChatRegistry } from '../chats/store.js';
import { ValidationDomainError } from '../lib/domain-error.js';
import { jsonError, jsonErrorFromUnknown } from '../lib/http-error.js';
import { disableRequestIdleTimeout } from '../lib/http-route.js';
import { createLogger } from '../lib/log.js';

const MAX_SEARCH_QUERY_CHARS = 4_096;
const MAX_SEARCH_TEXT_TOKEN_CHARS = 1_024;
const MAX_SEARCH_TEXT_CHARS = 8_192;
const MAX_SEARCH_CHAT_ID_CHARS = 512;
const logger = createLogger('routes:chat-search');

export interface ChatSearchDep {
  catalogMayHaveChanged(chatId: string): void;
  validateResultView(chatId: string, transcriptViewId: string): boolean;
  status(): TranscriptSearchStatusV1;
  queryStats(): TranscriptSearchQueryStatsV1;
  search(options: {
    query: string;
    textTokens?: string[];
    allowedChatIds: string[];
    sort: ChatSearchSort;
    mode: ChatSearchResultMode;
    offset: number;
    limit?: number;
    snippetLimit: number;
    signal?: AbortSignal;
  }): Promise<{
    mode: ChatSearchResultMode;
    snippetLimit: number;
    results: ChatSearchResponse['results'];
    page: ChatSearchResponse['page'];
    index: ChatSearchResponse['index'];
    removedStaleResultCount: number;
  }>;
}

export interface TranscriptSearchMaintenanceDep {
  rebuild(): Promise<void>;
}

interface ChatSearchRouteDeps {
  registry: IChatRegistry;
  chatListProjector: ChatListProjector;
  searchIndex?: ChatSearchDep;
  searchMaintenance?: TranscriptSearchMaintenanceDep;
}

interface NormalizedChatSearchRequest extends ChatSearchRequest {
  effectiveQuery: string;
  sort: ChatSearchSort;
  mode: ChatSearchResultMode;
  offset: number;
  snippetLimit: number;
}

const CLIENT_CLOSED_REQUEST_STATUS = 499;

export function createChatSearchRoutes(deps: ChatSearchRouteDeps): {
  postSearchChats(body: unknown, request?: Request): Promise<Response>;
  postSearchNavigate(body: unknown): Promise<Response>;
  postSearchRebuild(request: Request, url: URL, server?: unknown): Promise<Response>;
  getSearchStatus(): Response;
} {
  const { registry, chatListProjector, searchIndex, searchMaintenance } = deps;

  async function postSearchChats(body: unknown, request?: Request): Promise<Response> {
    const requestStarted = performance.now();
    let candidateAdmissionMs = 0;
    let controllerMs = 0;
    let explicitChatIds = false;
    let requestedChatCount = 0;
    let admittedChatCount = 0;
    try {
      if (!searchIndex) {
        throw new TranscriptSearchUnavailableError(
          'SEARCH_INDEX_UNAVAILABLE',
          'Chat search index is not available',
          true,
        );
      }
      const search = parseSearchRequest(body);
      explicitChatIds = search.chatIds !== undefined;
      requestedChatCount = search.chatIds?.length ?? 0;
      request?.signal.throwIfAborted();
      const candidateAdmissionStarted = performance.now();
      const allowedChatIds = await searchableChatIds(
        registry,
        chatListProjector,
        search.chatIds,
        search.sort,
        request?.signal,
      );
      candidateAdmissionMs = performance.now() - candidateAdmissionStarted;
      admittedChatCount = allowedChatIds.length;
      request?.signal.throwIfAborted();
      const controllerStarted = performance.now();
      const result = await searchIndex.search({
        query: search.effectiveQuery,
        textTokens: search.textTokens,
        allowedChatIds,
        sort: search.sort,
        mode: search.mode,
        offset: search.offset,
        limit: search.limit,
        snippetLimit: search.snippetLimit,
        signal: request?.signal,
      });
      controllerMs = performance.now() - controllerStarted;
      return Response.json({
        query: search.query,
        mode: result.mode,
        snippetLimit: result.snippetLimit,
        results: result.results,
        page: result.page,
        index: result.index,
        removedStaleResultCount: result.removedStaleResultCount,
      } satisfies ChatSearchResponse);
    } catch (error: unknown) {
      if (error instanceof TranscriptSearchUnavailableError && error.code === 'SEARCH_TIMEOUT') {
        logger.warn('Transcript search route timed out', {
          code: error.code,
          explicitChatIds,
          requestedChatCount,
          admittedChatCount,
          candidateAdmissionMs: Math.round(candidateAdmissionMs),
          controllerMs: Math.round(
            controllerMs || performance.now() - requestStarted - candidateAdmissionMs,
          ),
          totalMs: Math.round(performance.now() - requestStarted),
        });
      }
      if (request?.signal.aborted && isAbortError(error)) {
        return new Response(null, { status: CLIENT_CLOSED_REQUEST_STATUS });
      }
      return jsonErrorFromUnknown(error);
    }
  }

  async function postSearchNavigate(body: unknown): Promise<Response> {
    try {
      const request = parseSearchNavigateRequest(body);
      const session = registry.getChat(request.chatId);
      if (!session) return jsonError('Session not found', 404, 'SESSION_NOT_FOUND');
      if (!searchIndex?.validateResultView(request.chatId, request.transcriptViewId)) {
        return jsonError('The search result no longer matches the chat', 409, 'SEARCH_RESULT_STALE');
      }
      return Response.json({
        chatId: request.chatId,
        ordinal: request.ordinal,
      } satisfies ChatSearchNavigateResponse);
    } catch (error: unknown) {
      return jsonErrorFromUnknown(error);
    }
  }

  async function postSearchRebuild(
    request: Request,
    _url: URL,
    server?: unknown,
  ): Promise<Response> {
    try {
      if (!searchIndex || !searchMaintenance) {
        throw new TranscriptSearchUnavailableError(
          'SEARCH_INDEX_UNAVAILABLE',
          'Chat search index is not available',
          true,
        );
      }
      disableRequestIdleTimeout(request, server);
      await searchMaintenance.rebuild();
      return Response.json({
        success: true,
        status: currentSearchStatus(searchIndex),
      } satisfies TranscriptSearchRebuildResponse);
    } catch (error) {
      if (error instanceof TranscriptSearchSettingsError) {
        const disabled = error.code === 'TRANSCRIPT_SEARCH_DISABLED';
        return jsonError(error.message, disabled ? 409 : 500, error.code, false);
      }
      return jsonErrorFromUnknown(error);
    }
  }

  function getSearchStatus(): Response {
    return Response.json(currentSearchStatus(searchIndex));
  }

  return { postSearchChats, postSearchNavigate, postSearchRebuild, getSearchStatus };
}

function currentSearchStatus(searchIndex?: ChatSearchDep): TranscriptSearchStatusResponse {
  if (!searchIndex) {
    return {
      version: 1,
      phase: 'disabled',
      chats: { total: 0, indexed: 0, pending: 0, failed: 0, unindexed: 0 },
      queuedJobs: 0,
      resync: null,
      backlogRows: 0,
      activeChat: null,
      lastErrorCode: null,
      updatedAt: new Date(0).toISOString(),
      queryStats: {
        served: 0,
        timedOut: 0,
        rejectedBusy: 0,
        p50Ms: 0,
        p95Ms: 0,
        maxMs: 0,
        admissionP50Ms: 0,
        admissionP95Ms: 0,
        admissionMaxMs: 0,
        totalP50Ms: 0,
        totalP95Ms: 0,
        totalMaxMs: 0,
      },
    };
  }
  return {
    ...searchIndex.status(),
    queryStats: searchIndex.queryStats(),
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function parseSearchNavigateRequest(body: unknown): ChatSearchNavigateRequest {
  const raw = body && typeof body === 'object' ? body as Record<string, unknown> : null;
  if (
    !raw
    || typeof raw.chatId !== 'string' || raw.chatId.length === 0
    || typeof raw.transcriptViewId !== 'string' || raw.transcriptViewId.length === 0
    || !Number.isSafeInteger(raw.ordinal)
    || (raw.ordinal as number) < 1
  ) {
    throw new ValidationDomainError('Invalid search navigation request');
  }
  return {
    chatId: raw.chatId,
    transcriptViewId: raw.transcriptViewId,
    ordinal: raw.ordinal as number,
  };
}

function parseSearchRequest(body: unknown): NormalizedChatSearchRequest {
  const input = body && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  const textTokens = optionalBoundedStringArrayField(input, 'textTokens', {
    maxItems: CHAT_SEARCH_MAX_TERMS,
    maxItemChars: MAX_SEARCH_TEXT_TOKEN_CHARS,
    maxTotalChars: MAX_SEARCH_TEXT_CHARS,
  });
  const rawQuery = typeof input.query === 'string' ? input.query : '';
  if (rawQuery.length > MAX_SEARCH_QUERY_CHARS) {
    throw new ValidationDomainError(`query must be at most ${MAX_SEARCH_QUERY_CHARS} characters`);
  }
  const normalizedQuery = rawQuery.trim();
  const effectiveTerms = textTokens?.length
    ? textTokens
    : [...normalizedQuery.matchAll(/"([^"]+)"|(\S+)/g)]
        .map((match) => match[1] ?? match[2] ?? '');
  if (effectiveTerms.length > CHAT_SEARCH_MAX_TERMS) {
    throw new ValidationDomainError(`search must contain at most ${CHAT_SEARCH_MAX_TERMS} terms`);
  }
  const wordCount = effectiveTerms.reduce(
    (count, term) => count + (term.match(/[\p{L}\p{N}_]+/gu)?.length ?? 0),
    0,
  );
  if (wordCount > CHAT_SEARCH_MAX_WORDS) {
    throw new ValidationDomainError(`search must contain at most ${CHAT_SEARCH_MAX_WORDS} words`);
  }
  const effectiveQuery = normalizedQuery || textTokens?.join(' ') || '';
  if (!effectiveQuery) throw new ValidationDomainError('query is required');
  const mode = optionalSearchResultMode(input.mode) ?? 'page';
  const offset = optionalBoundedOffset(input.offset) ?? 0;
  const snippetLimit = optionalSnippetLimit(input.snippetLimit)
    ?? CHAT_SEARCH_MAX_SNIPPETS_PER_CHAT;
  if (mode === 'prefix' && (offset !== 0 || snippetLimit !== 1)) {
    throw new ValidationDomainError('prefix mode requires offset 0 and snippetLimit 1');
  }

  return {
    query: rawQuery,
    effectiveQuery,
    textTokens,
    chatIds: optionalBoundedStringArrayField(input, 'chatIds', {
      maxItems: CHAT_SEARCH_MAX_CHAT_IDS,
      maxItemChars: MAX_SEARCH_CHAT_ID_CHARS,
      maxTotalChars: CHAT_SEARCH_MAX_CHAT_IDS * MAX_SEARCH_CHAT_ID_CHARS,
    }),
    sort: optionalSearchSort(input.sort) ?? 'relevance',
    mode,
    offset,
    limit: optionalResultLimit(input.limit, mode),
    snippetLimit,
  };
}

async function searchableChatIds(
  registry: IChatRegistry,
  chatListProjector: ChatListProjector,
  requestedChatIds: string[] | undefined,
  sort: ChatSearchSort,
  signal?: AbortSignal,
): Promise<string[]> {
  const sessionEntries = requestedChatIds === undefined
    ? Object.entries(registry.listAllChats())
    : [...new Set(requestedChatIds)].flatMap((chatId) => {
      const session = registry.getChat(chatId);
      return session ? [[chatId, session] as const] : [];
    });
  signal?.throwIfAborted();
  const visibleEntries = chatListProjector.buildMany(sessionEntries);
  const entries = [...visibleEntries.values()];
  if (sort === 'relevance') return entries.map((entry) => entry.id);
  const timestamps = (entry: ChatListEntry): ChatOrderTimestamps => ({
    id: entry.id,
    createdAt: entry.activity.createdAt,
    lastActivityAt: entry.activity.lastActivityAt,
  });
  const timeFor = sort === 'created' ? chatCreationTimeMs : chatActivityTimeMs;
  return entries
    .map((entry) => ({ entry, time: timeFor(timestamps(entry)) }))
    .sort((left, right) => right.time - left.time
      || left.entry.id.localeCompare(right.entry.id))
    .map(({ entry }) => entry.id);
}

function optionalSearchSort(value: unknown): ChatSearchSort | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !CHAT_SEARCH_SORT_VALUES.includes(value as ChatSearchSort)) {
    throw new ValidationDomainError('sort must be relevance, activity, or created');
  }
  return value as ChatSearchSort;
}

function optionalSearchResultMode(value: unknown): ChatSearchResultMode | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string'
      || !CHAT_SEARCH_RESULT_MODES.includes(value as ChatSearchResultMode)) {
    throw new ValidationDomainError('mode must be page or prefix');
  }
  return value as ChatSearchResultMode;
}

function optionalBoundedOffset(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > CHAT_SEARCH_MAX_OFFSET) {
    throw new ValidationDomainError(`offset must be an integer from 0 to ${CHAT_SEARCH_MAX_OFFSET}`);
  }
  return Number(value);
}

function optionalResultLimit(
  value: unknown,
  mode: ChatSearchResultMode,
): number | undefined {
  if (value === undefined) return undefined;
  const maximum = mode === 'prefix' ? CHAT_SEARCH_MAX_PREFIX_SIZE : CHAT_SEARCH_MAX_PAGE_SIZE;
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) {
    throw new ValidationDomainError(`limit must be an integer from 1 to ${maximum}`);
  }
  return Number(value);
}

function optionalSnippetLimit(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value)
      || Number(value) < 1
      || Number(value) > CHAT_SEARCH_MAX_SNIPPETS_PER_CHAT) {
    throw new ValidationDomainError(
      `snippetLimit must be an integer from 1 to ${CHAT_SEARCH_MAX_SNIPPETS_PER_CHAT}`,
    );
  }
  return Number(value);
}

function stringArrayOrNull(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null;
}

function optionalBoundedStringArrayField(
  body: Record<string, unknown>,
  field: string,
  limits: { maxItems: number; maxItemChars: number; maxTotalChars: number },
): string[] | undefined {
  if (body[field] === undefined) return undefined;
  const values = stringArrayOrNull(body[field]);
  if (!values) throw new ValidationDomainError(`${field} must be an array of strings`);
  if (values.length > limits.maxItems) {
    throw new ValidationDomainError(`${field} must contain at most ${limits.maxItems} items`);
  }
  let totalChars = 0;
  for (const value of values) {
    if (value.length > limits.maxItemChars) {
      throw new ValidationDomainError(`${field} entries must be at most ${limits.maxItemChars} characters`);
    }
    totalChars += value.length;
    if (totalChars > limits.maxTotalChars) {
      throw new ValidationDomainError(`${field} is too large`);
    }
  }
  return values.map((value) => value.trim()).filter(Boolean);
}
