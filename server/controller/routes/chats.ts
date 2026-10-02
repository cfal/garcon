// /api/chats/* route handlers for registry operations and ledger-backed transcripts.

import { AgentCallError, type ExecutionProjectService } from '@garcon/server-agent-interface';
import {
  parseDeleteChatCommandRequest
} from '../../../common/chat-command-contracts.js';
import type { ChatDetailsResponse } from '../../../common/chat-details.js';
import type {
  ChatListEntry,
  ChatListResponse,
  ChatOrderGroup,
  MarkChatsReadRequest,
  MarkChatsReadResponse,
  SetLastSelectedChatRequest,
  SetLastSelectedChatResponse,
} from '../../../common/chat-list.js';
import {
  parseReorderChatRequest,
  parseSetChatArchivedRequest,
  parseSetChatPinnedRequest,
  parseSortChatOrderRequest,
  type ReorderChatRequest,
  type ReorderChatResponse,
  type SortChatOrderResponse,
} from '../../../common/chat-order-contracts.js';
import type { ChatOrderIdComparator } from '../../../common/chat-order-sort.js';
import type {
  GenerateChatTitleRequest,
  GenerateChatTitleResponse,
} from '../../../common/chat-title-contracts.js';
import type {
  CompleteChatHistoryResponse,
  TranscriptReadPurpose,
  UnavailableChatHistoryResponse,
} from '../../../common/chat-view.js';
import { DomainError, ValidationDomainError } from '../../common/domain-error.js';
import { jsonError, jsonErrorFromUnknown } from '../../common/http-error.js';
import type { KeyedPromiseLock } from '../../common/keyed-lock.js';
import { createLogger } from '../../common/log.js';
import type { AgentRegistryServiceContract } from '../agents/registry.js';
import {
  type ChatExecutionService
} from '../chat-execution/chat-execution-coordinator.js';
import {
  archivedLogicalCount,
  carryOverRevision,
} from '../chats/carryover/segments.js';
import type { TranscriptPageReader } from '../chats/chat-message-reader.js';
import { buildChatOrderComparator } from '../chats/chat-order-ranking.js';
import type { ChatProcessingActivity } from '../chats/chat-processing-activity.js';
import { TranscriptHistoryUnavailableError } from '../chats/errors.js';
import { InMemoryLastSelectedChatState, type LastSelectedChatState } from '../chats/last-selected-chat-state.js';
import type { ChatMetadata } from '../chats/metadata-store.js';
import type { RecentTitleIconSource } from '../chats/recent-title-icons.js';
import type { IChatRegistry } from '../chats/store.js';
import {
  generateChatTitleFromMessage,
  TitleGenerationError,
} from '../chats/title-generator.js';
import type { ChatCommandService } from '../commands/chat-command-service.js';
import { safeFenceDiagnostic, StaleTranscriptViewError } from '../ledger/errors.js';
import { commandHttpError, parseCommandRequest } from '../lib/command-http-error.js';
import { composeRoutes } from '../lib/compose-routes.js';
import type { RouteMap } from '../lib/http-route-types.js';
import { withJsonBody } from '../lib/json-route.js';
import { CHAT_MESSAGES_MAX_LIMIT } from '../../../common/chat-view.js';
import type {
  ChatOrderComparatorOverrides,
  ChatOrderStateMutationResult,
  ChatReorderResult,
  ChatStartupPreferences,
  UiSettings,
} from '../settings/types.js';
import { createChatCommandRoutes } from './chat-command-routes.js';
import {
  createChatSearchRoutes,
  type ChatSearchDep,
  type TranscriptSearchMaintenanceDep,
} from './chat-search-routes.js';
import { executorIdFromUrl } from './executor-target.js';
import { requireStringField } from './route-helpers.js';

const logger = createLogger('routes:chats');

interface SettingsDep {
  getPinnedChatIds(): string[];
  getNormalChatIds(): string[];
  getArchivedChatIds(): string[];
  getUiSettings(): UiSettings | null | undefined;
  getChatName(chatId: string): string | null;
  setSessionName(chatId: string, title: string): Promise<unknown>;
  setSessionNameIfAbsent(chatId: string, title: string): Promise<boolean>;
  recordChatStartup(defaults: ChatStartupPreferences): Promise<void>;
  ensureInNormal(chatId: string): Promise<void>;
  removeFromAllOrderLists(chatId: string): Promise<void>;
  removeSessionName(chatId: string): Promise<void>;
  togglePin(chatId: string): Promise<{ isPinned: boolean }>;
  toggleArchive(chatId: string): Promise<{ isArchived: boolean }>;
  setPinned(
    chatId: string,
    isPinned: boolean,
    isKnownChat: (chatId: string) => boolean,
  ): Promise<ChatOrderStateMutationResult>;
  setArchived(
    chatId: string,
    isArchived: boolean,
    isKnownChat: (chatId: string) => boolean,
  ): Promise<ChatOrderStateMutationResult>;
  reorderChat(
    request: ReorderChatRequest,
    isKnownChat: (chatId: string) => boolean,
  ): Promise<ChatReorderResult>;
  sortChatOrder(
    compareChatIds: ChatOrderIdComparator,
    comparatorOverrides?: ChatOrderComparatorOverrides,
  ): Promise<{ changed: boolean }>;
}

interface MetadataDep {
  listAllChatMetadata(): Map<string, ChatMetadata>;
  getChatMetadata(chatId: string): ChatMetadata | null;
  addNewChatMetadata(chatId: string, command: string): void;
}

type QueueDep = ChatExecutionService;
type ChatViewsDep = TranscriptPageReader;
type AgentRegistryDep = AgentRegistryServiceContract;

function bodyRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
}

function chatIdFromBodyOrQuery(body: unknown, url: URL): string {
  const input = bodyRecord(body);
  const bodyChatId = typeof input.chatId === 'string' ? input.chatId.trim() : '';
  if (bodyChatId) return bodyChatId;
  return url.searchParams.get('chatId')?.trim() || '';
}

function optionalNonNegativeIntegerField(body: Record<string, unknown>, field: string): number | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  throw new ValidationDomainError(`${field} must be a non-negative integer`);
}

function parseBeforeOrdinal(value: string | null): number | Response | undefined {
  if (value === null || value.trim() === '') return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return jsonError('beforeOrdinal must be a positive integer', 400, 'VALIDATION_FAILED');
  }
  return parsed;
}

function parseMessagesLimit(value: string | null): number | Response {
  if (value === null || value.trim() === '') return 20;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return jsonError('limit must be a positive integer', 400, 'VALIDATION_FAILED', false);
  }
  return Math.min(parsed, CHAT_MESSAGES_MAX_LIMIT);
}

function parseTranscriptReadPurpose(
  value: string | null,
): TranscriptReadPurpose | Response | undefined {
  if (value === null) return undefined;
  if (value === 'activation') return value;
  return jsonError('purpose must be activation', 400, 'VALIDATION_FAILED', false);
}

function pathValidationError(error: string, errorCode: string, status = 200): Response {
  return Response.json(
    {
      success: false,
      valid: false,
      error,
      errorCode,
      retryable: false,
    },
    { status },
  );
}

interface ChatRouteDeps {
  registry: IChatRegistry;
  settings: SettingsDep;
  recentTitleIcons: RecentTitleIconSource;
  queue: QueueDep;
  processing: Pick<ChatProcessingActivity, 'phase'>;
  metadata: MetadataDep;
  chatViews: ChatViewsDep;
  agents: AgentRegistryDep;
  commandService: ChatCommandService;
  chatListProjector: import('../chats/chat-list-projector.js').ChatListProjector;
  searchIndex?: ChatSearchDep;
  transcriptSearchMaintenance?: TranscriptSearchMaintenanceDep;
  lastSelectedChat?: LastSelectedChatState;
  projects(executorId: string): Promise<ExecutionProjectService>;
  chatMutationLock: Pick<KeyedPromiseLock, 'runExclusive'>;
}

export default function createChatRoutes({
  registry,
  settings,
  recentTitleIcons,
  queue,
  processing,
  metadata,
  chatViews,
  agents,
  commandService,
  chatListProjector,
  searchIndex,
  transcriptSearchMaintenance,
  lastSelectedChat = new InMemoryLastSelectedChatState(),
  projects,
  chatMutationLock,
}: ChatRouteDeps): RouteMap {
  const searchRoutes = createChatSearchRoutes({
    registry,
    chatListProjector,
    searchIndex,
    searchMaintenance: transcriptSearchMaintenance,
  });

  function validatedLastSelectedChatId(
    rememberedChatId: string | null,
    allSessions: Record<string, unknown>,
  ): string | null {
    if (!rememberedChatId) return null;
    if (!(rememberedChatId in allSessions)) {
      lastSelectedChat.clearIf(rememberedChatId);
      return null;
    }
    return rememberedChatId;
  }

  async function validateStartPath(request: Request, url: URL): Promise<Response> {
    const dirPath = String(url.searchParams.get('path') || '').trim();
    if (!dirPath) {
      return pathValidationError('path is required', 'path_required', 400);
    }

    try {
      const { resolution, isGitRepository } = await (await projects(executorIdFromUrl(url, registry))).inspect(
        { projectPath: dirPath, includeGitRepository: true }, { signal: request.signal },
      );
      if (resolution.kind === 'unavailable') {
        switch (resolution.reason) {
          case 'not-found':
            return pathValidationError('Path does not exist', 'path_not_found');
          case 'not-a-directory':
            return pathValidationError('Not a directory', 'not_directory');
          case 'outside-base':
            return pathValidationError(
              'Path is outside the allowed base directory',
              'outside_base_dir',
            );
          case 'permission-denied':
            return pathValidationError('Permission denied', 'permission_denied');
        }
      }
      return Response.json({ valid: true, isGitRepo: isGitRepository ?? false });
    } catch (error: unknown) {
      if (request.signal.aborted) return new Response(null, { status: 499 });
      if (error instanceof AgentCallError || error instanceof DomainError) return jsonErrorFromUnknown(error);
      return pathValidationError((error as Error).message, 'unknown');
    }
  }

  async function getChats(): Promise<Response> {
    try {
      const sessions = registry.listAllChats();
      const pinnedList = settings.getPinnedChatIds();
      const normalList = settings.getNormalChatIds();
      const archivedList = settings.getArchivedChatIds();
      const sessionEntries = Object.entries(sessions);
      const entryMap = chatListProjector.buildMany(sessionEntries);
      const orderedFrom = (ids: string[], group: ChatOrderGroup): ChatListEntry[] =>
        ids.flatMap((id) => {
          const entry = entryMap.get(id);
          return entry?.orderGroup === group ? [entry] : [];
        });
      const orphans = [...entryMap.values()]
        .filter((entry) => entry.orderGroup === 'orphan')
        .sort(
          (a, b) => (b.activity.createdAt || '').localeCompare(a.activity.createdAt || '') || a.id.localeCompare(b.id),
        );
      const all = [
        ...orderedFrom(pinnedList, 'pinned'),
        ...orphans,
        ...orderedFrom(normalList, 'normal'),
        ...orderedFrom(archivedList, 'archived'),
      ];
      const lastSelectedChatId = validatedLastSelectedChatId(
        lastSelectedChat.getLastSelectedChatId(),
        sessions,
      );
      const body: ChatListResponse = {
        sessions: all,
        total: all.length,
        lastSelectedChatId,
      };
      return Response.json(body);
    } catch (error: unknown) {
      logger.error('sessions: error listing sessions:', error as Error);
      return jsonErrorFromUnknown(error);
    }
  }

  async function deleteSessionHandler(body: unknown, _request: Request, url: URL): Promise<Response> {
    const chatId = chatIdFromBodyOrQuery(body, url);
    if (!chatId) return jsonError('chatId is required', 400);

    try {
      const input = parseCommandRequest(parseDeleteChatCommandRequest, { chatId });
      await commandService.deleteChat(input);
      lastSelectedChat.clearIf(chatId);
      return Response.json({ success: true });
    } catch (error: unknown) {
      return commandHttpError(error);
    }
  }

  async function putLastSelectedChat(body: SetLastSelectedChatRequest | unknown): Promise<Response> {
    const input = bodyRecord(body);
    const rawChatId = input.chatId;
    if (rawChatId === null) {
      lastSelectedChat.setLastSelectedChatId(null);
      return Response.json({
        success: true,
        lastSelectedChatId: null,
      } satisfies SetLastSelectedChatResponse);
    }

    const chatId = typeof rawChatId === 'string' ? rawChatId.trim() : '';
    if (!chatId) {
      return jsonError('chatId is required', 400, 'VALIDATION_FAILED');
    }
    if (!registry.hasChat(chatId)) {
      return jsonError('Session not found', 404, 'SESSION_NOT_FOUND');
    }

    lastSelectedChat.setLastSelectedChatId(chatId);
    return Response.json({
      success: true,
      lastSelectedChatId: chatId,
    } satisfies SetLastSelectedChatResponse);
  }

  async function getMessages(request: Request, url: URL): Promise<Response> {
    const chatId = url.searchParams.get('chatId');
    if (!chatId) return jsonError('chatId query parameter is required', 400);

    try {
      const session = registry.getChat(chatId);
      if (!session) {
        return jsonError('Session not found', 404, 'SESSION_NOT_FOUND');
      }

      const limit = parseMessagesLimit(url.searchParams.get('limit'));
      if (limit instanceof Response) return limit;
      const beforeOrdinalRaw = url.searchParams.get('beforeOrdinal');
      const beforeOrdinal = parseBeforeOrdinal(beforeOrdinalRaw);
      if (beforeOrdinal instanceof Response) return beforeOrdinal;
      const purpose = parseTranscriptReadPurpose(url.searchParams.get('purpose'));
      if (purpose instanceof Response) return purpose;
      const expectedTranscriptViewId = url.searchParams.get('transcriptViewId')?.trim() ?? '';
      if (beforeOrdinal !== undefined && !expectedTranscriptViewId) {
        return jsonError(
          'transcriptViewId query parameter is required for earlier pages',
          400,
          'VALIDATION_FAILED',
          false,
        );
      }
      if (beforeOrdinal !== undefined && purpose === 'activation') {
        return jsonError(
          'activation purpose is valid only for newest history',
          400,
          'VALIDATION_FAILED',
          false,
        );
      }

      const page = await chatViews.page(
        chatId,
        limit,
        beforeOrdinal,
        expectedTranscriptViewId || undefined,
        request.signal,
        purpose,
      );
      if (
        expectedTranscriptViewId
        && page.transcriptViewId !== expectedTranscriptViewId
      ) {
        return jsonError(
          'Transcript view changed while paging',
          409,
          'STALE_TRANSCRIPT_VIEW',
          false,
        );
      }
      return Response.json({
        historyState: { kind: 'complete' },
        chatId,
        transcriptViewId: page.transcriptViewId,
        messages: page.messages,
        lastOrdinal: page.lastOrdinal,
        pageOldestOrdinal: page.pageOldestOrdinal,
        pageNewestOrdinal: page.pageNewestOrdinal,
        nextBeforeOrdinal: page.nextBeforeOrdinal,
        hasMore: page.hasMore,
        resendCandidates: processing.phase(chatId) === null
          ? [...agents.resendCandidates(chatId)]
          : [],
        limit,
      } satisfies CompleteChatHistoryResponse);
    } catch (error: unknown) {
      if (request.signal.aborted) return new Response(null, { status: 499 });
      // A fenced ledger is permanent for the process, and its cause can carry a database path or
      // chat identity. It reports one fixed line with sanitized identifiers and returns before the
      // generic diagnostic below, which logs the raw message.
      if (
        error instanceof TranscriptHistoryUnavailableError
        && error.historyState.errorCode === 'LEDGER_FENCED'
      ) {
        logger.warn('Transcript ledger read is fenced.', safeFenceDiagnostic(error.cause));
        return Response.json({
          historyState: error.historyState,
          chatId,
          messages: [],
        } satisfies UnavailableChatHistoryResponse);
      }
      logger.error(`sessions: error reading messages for ${chatId}:`, (error as Error).message);
      if (error instanceof StaleTranscriptViewError) {
        return jsonError(
          'Transcript view changed while paging',
          409,
          'STALE_TRANSCRIPT_VIEW',
          false,
        );
      }
      if (error instanceof DomainError && error.code === 'CARRYOVER_HISTORY_UNAVAILABLE') {
        return Response.json({
          historyState: {
            kind: 'degraded',
            errorCode: 'CARRYOVER_HISTORY_UNAVAILABLE',
            retryable: false,
          },
          chatId,
          messages: [],
        } satisfies UnavailableChatHistoryResponse);
      }
      // A non-ready transcript read is a typed history state, not exhaustion:
      // deferred retries once on the execution-to-idle transition and degraded
      // carries the store's own failure code.
      if (error instanceof TranscriptHistoryUnavailableError) {
        return Response.json({
          historyState: error.historyState,
          chatId,
          messages: [],
        } satisfies UnavailableChatHistoryResponse);
      }
      return jsonErrorFromUnknown(error);
    }
  }

  async function getChatDetails(_request: Request, url: URL): Promise<Response> {
    const chatId = url.searchParams.get('chatId');
    if (!chatId) return jsonError('chatId query parameter is required', 400);

    try {
      const session = registry.getChat(chatId);
      if (!session) {
        return jsonError('Session not found', 404, 'SESSION_NOT_FOUND');
      }

      const meta = metadata.getChatMetadata(chatId);
      const response: ChatDetailsResponse = {
        chatId,
        firstMessage: meta?.firstMessage || '',
        createdAt: meta?.createdAt || null,
        lastActivityAt: meta?.lastActivity || null,
        agentSessionId: session.agentSessionId || null,
        transcriptSource: await agents.describeTranscriptSource(session, chatId),
        carryOver: {
          revision: carryOverRevision(
            session.carryOverSegments,
            session.carryOverMigrationQuarantine,
          ),
          archivedMessageCount: archivedLogicalCount(session.carryOverSegments),
          segments: session.carryOverSegments.map((ref) => ({
            id: ref.id,
            agentId: ref.agentId,
            model: ref.model,
            capturedAt: ref.capturedAt,
            storedMessageCount: ref.storedMessageCount,
            visibleMessageCount: ref.visibleMessageCount,
            truncated: ref.visibleMessageCount < ref.storedMessageCount,
            trailingHandoff: ref.trailingHandoff ? { ...ref.trailingHandoff } : null,
          })),
        },
      };
      return Response.json(response);
    } catch (error: unknown) {
      return jsonErrorFromUnknown(error);
    }
  }

  async function postTogglePin(body: unknown, _request: Request, url: URL): Promise<Response> {
    const chatId = chatIdFromBodyOrQuery(body, url);
    if (!chatId) return jsonError('chatId is required', 400);

    try {
      return await chatMutationLock.runExclusive(`chat:${chatId}`, async () => {
        const session = registry.getChat(chatId);
        if (!session) {
          return jsonError('Session not found', 404, 'SESSION_NOT_FOUND');
        }

        const result = await settings.togglePin(chatId);
        return Response.json({ success: true, isPinned: result.isPinned });
      });
    } catch (error: unknown) {
      return jsonErrorFromUnknown(error);
    }
  }

  async function postToggleArchive(body: unknown, _request: Request, url: URL): Promise<Response> {
    const chatId = chatIdFromBodyOrQuery(body, url);
    if (!chatId) return jsonError('chatId is required', 400);

    try {
      return await chatMutationLock.runExclusive(`chat:${chatId}`, async () => {
        const session = registry.getChat(chatId);
        if (!session) {
          return jsonError('Session not found', 404, 'SESSION_NOT_FOUND');
        }

        const result = await settings.toggleArchive(chatId);
        return Response.json({ success: true, isArchived: result.isArchived });
      });
    } catch (error: unknown) {
      return jsonErrorFromUnknown(error);
    }
  }

  async function putPinned(body: unknown): Promise<Response> {
    try {
      const request = parseSetChatPinnedRequest(body);
      if (!request) {
        return jsonError('Invalid desired pinned state', 400, 'VALIDATION_FAILED', false);
      }
      const result = await settings.setPinned(
        request.chatId,
        request.isPinned,
        (chatId) => registry.hasChat(chatId),
      );
      if (!result.success) {
        return jsonError(result.error, result.status, result.errorCode, false);
      }
      return Response.json(result.response);
    } catch (error: unknown) {
      return jsonErrorFromUnknown(error);
    }
  }

  async function putArchived(body: unknown): Promise<Response> {
    try {
      const request = parseSetChatArchivedRequest(body);
      if (!request) {
        return jsonError('Invalid desired archived state', 400, 'VALIDATION_FAILED', false);
      }
      const result = await settings.setArchived(
        request.chatId,
        request.isArchived,
        (chatId) => registry.hasChat(chatId),
      );
      if (!result.success) {
        return jsonError(result.error, result.status, result.errorCode, false);
      }
      return Response.json(result.response);
    } catch (error: unknown) {
      return jsonErrorFromUnknown(error);
    }
  }

  async function postMarkRead(
    body: MarkChatsReadRequest & Record<string, unknown>,
  ): Promise<Response> {
    try {
      const entries = Array.isArray(body.entries) ? body.entries : [];
      if (entries.length === 0) {
        return Response.json({ success: true, results: [] } satisfies MarkChatsReadResponse);
      }

      const now = new Date().toISOString();
      const results: Array<{ chatId: string; lastReadAt: string }> = [];
      for (const entry of entries) {
        const chatId = String(entry.chatId || '').trim();
        if (!chatId) continue;

        const session = registry.getChat(chatId);
        if (!session) continue;

        const existing = session.lastReadAt || null;
        const merged = existing && existing > now ? existing : now;

        if (merged !== existing) {
          registry.updateChat(chatId, { lastReadAt: merged });
        }
        results.push({ chatId, lastReadAt: merged });
      }

      return Response.json({ success: true, results } satisfies MarkChatsReadResponse);
    } catch (error: unknown) {
      return jsonErrorFromUnknown(error);
    }
  }

  async function postReorderChat(body: unknown): Promise<Response> {
    try {
      const request = parseReorderChatRequest(body);
      if (!request) {
        return jsonError('Invalid chat reorder request', 400, 'VALIDATION_FAILED', false);
      }
      if (!registry.hasChat(request.chatId)) {
        return jsonError('Chat not found', 404, 'SESSION_NOT_FOUND', false);
      }
      if (
        request.placement.kind === 'relative'
        && !registry.hasChat(request.placement.referenceChatId)
      ) {
        return jsonError('Reference chat not found', 404, 'SESSION_NOT_FOUND', false);
      }

      const result = await settings.reorderChat(
        request,
        (chatId) => registry.hasChat(chatId),
      );
      if (!result.success) {
        return jsonError(result.error, result.status, result.errorCode, false);
      }
      return Response.json(result.response satisfies ReorderChatResponse);
    } catch (error: unknown) {
      return jsonErrorFromUnknown(error);
    }
  }

  async function postSortChatOrder(body: unknown): Promise<Response> {
    try {
      const request = parseSortChatOrderRequest(body);
      if (!request) {
        return jsonError(
          'Invalid chat order sort request',
          400,
          'VALIDATION_FAILED',
          false,
        );
      }

      const compareChatIds = buildChatOrderComparator(
        request.sortKey,
        metadata.listAllChatMetadata(),
      );
      const comparatorOverrides: ChatOrderComparatorOverrides =
        request.sortKey === 'activity'
        && settings.getUiSettings()?.pinnedInsertPosition === 'bottom'
          ? { pinned: (leftChatId, rightChatId) => compareChatIds(rightChatId, leftChatId) }
          : {};
      const result = await settings.sortChatOrder(compareChatIds, comparatorOverrides);
      return Response.json({
        success: true,
        sortKey: request.sortKey,
        changed: result.changed,
      } satisfies SortChatOrderResponse);
    } catch (error: unknown) {
      return jsonErrorFromUnknown(error);
    }
  }

  async function postGenerateChatTitle(
    body: Partial<GenerateChatTitleRequest> & Record<string, unknown>,
    request: Request,
  ): Promise<Response> {
    try {
      const chatId = requireStringField(body, 'chatId');
      const message = requireStringField(body, 'message');
      const messageSeq = optionalNonNegativeIntegerField(body, 'messageSeq');
      const session = registry.getChat(chatId);
      if (!session) return jsonError('Session not found', 404, 'SESSION_NOT_FOUND');

      const result = await generateChatTitleFromMessage({
        chatId,
        message,
        ...(messageSeq === undefined ? {} : { messageSeq }),
        agents,
        settings,
        recentTitleIcons,
        signal: request.signal,
      });

      const response: GenerateChatTitleResponse = {
        success: true,
        chatId,
        title: result.title,
      };
      return Response.json(response);
    } catch (error: unknown) {
      if (error instanceof TitleGenerationError) {
        return jsonError(error.message, error.status, error.code, error.retryable);
      }
      return jsonErrorFromUnknown(error);
    }
  }

  return composeRoutes({
    '/api/v1/chats': {
      GET: getChats,
      DELETE: withJsonBody(deleteSessionHandler),
    },
    '/api/v1/chats/last-selected': { PUT: withJsonBody(putLastSelectedChat) },
    '/api/v1/chats/title/generate': {
      POST: withJsonBody(postGenerateChatTitle),
    },
    '/api/v1/chats/validate-start': { GET: validateStartPath },
    '/api/v1/chats/messages': { GET: getMessages },
    '/api/v1/chats/search': { POST: withJsonBody(searchRoutes.postSearchChats) },
    '/api/v1/chats/search/navigate': { POST: withJsonBody(searchRoutes.postSearchNavigate) },
    '/api/v1/chats/search/rebuild': { POST: searchRoutes.postSearchRebuild },
    '/api/v1/chats/search/status': { GET: searchRoutes.getSearchStatus },
    '/api/v1/chats/details': { GET: getChatDetails },
    '/api/v1/chats/pin': {
      POST: withJsonBody(postTogglePin),
      PUT: withJsonBody(putPinned),
    },
    '/api/v1/chats/archive': {
      POST: withJsonBody(postToggleArchive),
      PUT: withJsonBody(putArchived),
    },
    '/api/v1/chats/read': { POST: withJsonBody(postMarkRead) },
    '/api/v1/chats/reorder': { POST: withJsonBody(postReorderChat) },
    '/api/v1/chats/sort': { POST: withJsonBody(postSortChatOrder) },
  }, createChatCommandRoutes({ commands: commandService, registry, agents, queue }));
}
