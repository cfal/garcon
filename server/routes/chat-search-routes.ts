import type {
  ChatSearchNavigateRequest,
  ChatSearchNavigateResponse,
  ChatSearchRequest,
  ChatSearchResponse,
  TranscriptSearchQueryStatsV1,
  TranscriptSearchStatusResponse,
  TranscriptSearchStatusV1,
} from '../../common/chat-search.js';
import { CHAT_SEARCH_MAX_TERMS, CHAT_SEARCH_MAX_WORDS } from '../../common/chat-search.js';
import type { ChatListProjector } from '../chats/chat-list-projector.js';
import { TranscriptSearchUnavailableError } from '../chats/search/errors.js';
import type { IChatRegistry } from '../chats/store.js';
import { ValidationDomainError } from '../lib/domain-error.js';
import { jsonError, jsonErrorFromUnknown } from '../lib/http-error.js';

const MAX_SEARCH_QUERY_CHARS = 4_096;
const MAX_SEARCH_TEXT_TOKEN_CHARS = 1_024;
const MAX_SEARCH_TEXT_CHARS = 8_192;
const MAX_SEARCH_CHAT_IDS = 10_000;
const MAX_SEARCH_CHAT_ID_CHARS = 512;

export interface ChatSearchDep {
  catalogMayHaveChanged(chatId: string): void;
  validateResultView(chatId: string, transcriptViewId: string): boolean;
  status(): TranscriptSearchStatusV1;
  queryStats(): TranscriptSearchQueryStatsV1;
  search(options: {
    query: string;
    textTokens?: string[];
    allowedChatIds: string[];
    limit?: number;
  }): Promise<{
    results: ChatSearchResponse['results'];
    index: ChatSearchResponse['index'];
  }>;
}

interface ChatSearchRouteDeps {
  registry: IChatRegistry;
  pathCache: {
    resolveProjectPaths(projectPaths: string[]): Promise<
      Map<string, { available: boolean; effectiveProjectKey: string | null }>
    >;
  };
  chatListProjector: ChatListProjector;
  searchIndex?: ChatSearchDep;
}

export function createChatSearchRoutes(deps: ChatSearchRouteDeps): {
  postSearchChats(body: unknown): Promise<Response>;
  postSearchNavigate(body: unknown): Promise<Response>;
  getSearchStatus(): Response;
} {
  const { registry, pathCache, chatListProjector, searchIndex } = deps;

  async function postSearchChats(body: unknown): Promise<Response> {
    try {
      if (!searchIndex) {
        throw new TranscriptSearchUnavailableError(
          'SEARCH_INDEX_UNAVAILABLE',
          'Chat search index is not available',
          true,
        );
      }
      const search = parseSearchRequest(body);
      const result = await searchIndex.search({
        query: search.query,
        textTokens: search.textTokens,
        allowedChatIds: await searchableChatIds(
          registry,
          pathCache,
          chatListProjector,
          search.chatIds,
        ),
        limit: search.limit,
      });
      return Response.json({
        query: search.query,
        results: result.results,
        total: result.results.length,
        index: result.index,
      } satisfies ChatSearchResponse);
    } catch (error: unknown) {
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

  function getSearchStatus(): Response {
    if (!searchIndex) {
      return Response.json({
        version: 1,
        phase: 'disabled',
        chats: { indexed: 0, pending: 0, failed: 0 },
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
        },
      } satisfies TranscriptSearchStatusResponse);
    }
    return Response.json({
      ...searchIndex.status(),
      queryStats: searchIndex.queryStats(),
    } satisfies TranscriptSearchStatusResponse);
  }

  return { postSearchChats, postSearchNavigate, getSearchStatus };
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

function parseSearchRequest(body: unknown): ChatSearchRequest {
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
  const query = rawQuery.trim();
  const effectiveTerms = textTokens?.length
    ? textTokens
    : [...query.matchAll(/"([^"]+)"|(\S+)/g)].map((match) => match[1] ?? match[2] ?? '');
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
  const effectiveQuery = query || textTokens?.join(' ') || '';
  if (!effectiveQuery) throw new ValidationDomainError('query is required');

  return {
    query: effectiveQuery,
    textTokens,
    chatIds: optionalBoundedStringArrayField(input, 'chatIds', {
      maxItems: MAX_SEARCH_CHAT_IDS,
      maxItemChars: MAX_SEARCH_CHAT_ID_CHARS,
      maxTotalChars: MAX_SEARCH_CHAT_IDS * MAX_SEARCH_CHAT_ID_CHARS,
    }),
    limit: optionalNonNegativeIntegerField(input, 'limit'),
  };
}

async function searchableChatIds(
  registry: IChatRegistry,
  pathCache: ChatSearchRouteDeps['pathCache'],
  chatListProjector: ChatListProjector,
  requestedChatIds: string[] | undefined,
): Promise<string[]> {
  const sessions = registry.listAllChats();
  const sessionEntries = Object.entries(sessions);
  const statuses = await pathCache.resolveProjectPaths(
    sessionEntries.map(([, session]) => session.projectPath),
  );
  const visibleEntries = await chatListProjector.buildMany(sessionEntries, statuses);
  if (requestedChatIds !== undefined) {
    return requestedChatIds.filter((chatId) => visibleEntries.has(chatId));
  }
  return [...visibleEntries.values()]
    .sort((left, right) => {
      const leftActivity = left.activity.lastActivityAt ?? left.activity.createdAt ?? '';
      const rightActivity = right.activity.lastActivityAt ?? right.activity.createdAt ?? '';
      return rightActivity.localeCompare(leftActivity) || left.id.localeCompare(right.id);
    })
    .map((entry) => entry.id);
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

function optionalNonNegativeIntegerField(
  body: Record<string, unknown>,
  field: string,
): number | undefined {
  if (body[field] === undefined) return undefined;
  const value = body[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ValidationDomainError(`${field} must be a non-negative integer`);
  }
  return value;
}
