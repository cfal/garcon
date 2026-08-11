import type {
  ChatSearchNavigateRequest,
  ChatSearchNavigateResponse,
  ChatSearchRequest,
  ChatSearchResponse,
} from '../../common/chat-search.js';
import { CHAT_SEARCH_MAX_TERMS, CHAT_SEARCH_MAX_WORDS } from '../../common/chat-search.js';
import type { AgentRegistryServiceContract } from '../agents/registry.js';
import { archivedLogicalCount } from '../chats/carryover-segments.js';
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
  catalogMayHaveChanged(chatId?: string): void;
  validateResultEpoch(chatId: string, contentEpoch: string): boolean;
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
  agents: Pick<AgentRegistryServiceContract, 'verifyProjectionEntry'>;
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
} {
  const { registry, agents, pathCache, chatListProjector, searchIndex } = deps;

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

  // Resolves one search snippet to a browser seq under the current composite
  // content epoch. A result that raced a reset, handoff, or carryover change
  // is rejected as stale so the client requeries instead of scrolling to a
  // possibly reused ordinal; ordinary tail append preserves navigation.
  async function postSearchNavigate(body: unknown): Promise<Response> {
    try {
      const request = parseSearchNavigateRequest(body);
      const session = registry.getChat(request.chatId);
      if (!session) return jsonError('Session not found', 404, 'SESSION_NOT_FOUND');
      if (!searchIndex?.validateResultEpoch(request.chatId, request.contentEpoch)) {
        return jsonError('The search result no longer matches the chat', 409, 'SEARCH_RESULT_STALE');
      }
      if (request.anchor.kind === 'current-entry') {
        const verified = request.anchor.agentOwnershipEpoch === session.agentOwnershipEpoch
          && await agents.verifyProjectionEntry(
            session,
            request.chatId,
            request.messageOrdinal - archivedLogicalCount(session.carryOverSegments),
            request.anchor.entryId,
          );
        if (!verified) {
          return jsonError('The search result no longer matches the chat', 409, 'SEARCH_RESULT_STALE');
        }
      }
      return Response.json({
        chatId: request.chatId,
        seq: request.messageOrdinal,
      } satisfies ChatSearchNavigateResponse);
    } catch (error: unknown) {
      return jsonErrorFromUnknown(error);
    }
  }

  return { postSearchChats, postSearchNavigate };
}

function parseSearchNavigateRequest(body: unknown): ChatSearchNavigateRequest {
  const raw = body && typeof body === 'object' ? body as Record<string, unknown> : null;
  const anchor = raw?.anchor && typeof raw.anchor === 'object'
    ? raw.anchor as Record<string, unknown>
    : null;
  const anchorKind = anchor?.kind;
  const validAnchor = anchor !== null && (
    (anchorKind === 'carryover-entry'
      && typeof anchor.segmentId === 'string'
      && Number.isSafeInteger(anchor.localOrdinal))
    || (anchorKind === 'agent-switch' && typeof anchor.segmentId === 'string')
    || (anchorKind === 'current-entry'
      && typeof anchor.agentOwnershipEpoch === 'string'
      && typeof anchor.entryId === 'string')
  );
  if (
    !raw
    || typeof raw.chatId !== 'string' || raw.chatId.length === 0
    || typeof raw.contentEpoch !== 'string' || raw.contentEpoch.length === 0
    || !Number.isSafeInteger(raw.messageOrdinal)
    || (raw.messageOrdinal as number) < 1
    || !validAnchor
  ) {
    throw new ValidationDomainError('Invalid search navigation request');
  }
  return {
    chatId: raw.chatId,
    contentEpoch: raw.contentEpoch,
    messageOrdinal: raw.messageOrdinal as number,
    anchor: raw.anchor as ChatSearchNavigateRequest['anchor'],
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
