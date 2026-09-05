// /api/chats/* route handlers for registry operations and ledger-backed transcripts.

import { promises as fs } from 'fs';
import { withJsonBody } from '../lib/json-route.js';
import type { IChatRegistry } from '../chats/store.js';
import {
  normalizePermissionMode,
  normalizeThinkingMode,
} from '../../common/chat-modes.js';
import type { JsonObject } from '../../common/json.js';
import { AGENT_HANDOFF_REQUEST_TIMEOUT_SECONDS } from '../../common/handoff-timeouts.js';
import {
  parseReorderChatRequest,
  parseSortChatOrderRequest,
  type ReorderChatRequest,
  type ReorderChatResponse,
  type SortChatOrderResponse,
} from '../../common/chat-order-contracts.js';
import type { ChatOrderIdComparator } from '../../common/chat-order-sort.js';
import { ModelSelectionError } from '../api-providers/endpoint-resolver.js';
import type { AgentSessionSettingsPatch } from '../agents/session-types.js';
import {
  CommandExecutionControlError,
  CommandValidationError,
} from '../commands/chat-command-service.js';
import type { ChatCommandService } from '../commands/chat-command-service.js';
import type { RecentTitleIconSource } from '../chats/recent-title-icons.js';
import {
  toClientChatExecutionControlState,
} from '../chat-execution/control-state.ts';
import { normalizeTags } from '../../common/tags.ts';
import type {
  ChatListEntry,
  ChatListResponse,
  ChatOrderGroup,
  MarkChatsReadRequest,
  MarkChatsReadResponse,
  SetLastSelectedChatRequest,
  SetLastSelectedChatResponse,
} from '../../common/chat-list.js';
import { CHAT_MESSAGES_MAX_LIMIT } from '../lib/pagination.js';
import { assertRealWithinProjectBase, isProjectBoundaryError } from '../lib/path-boundary.js';
import { jsonError, jsonErrorFromUnknown } from '../lib/http-error.js';
import {
  GoalControlDeliveryError,
  DomainError,
  QueueEntrySteerError,
  ValidationDomainError,
} from '../lib/domain-error.js';
import { AttachmentValidationError, validateCommandAttachments } from '../attachments/validation.js';
import { TranscriptHistoryUnavailableError } from '../chats/errors.js';
import type { ChatReorderResult, ChatStartupPreferences } from '../settings/types.js';
import type { RouteMap } from '../lib/http-route-types.js';
import { InMemoryLastSelectedChatState, type LastSelectedChatState } from '../chats/last-selected-chat-state.js';
import {
  QueueEntryMutationError,
  QueuePauseChangedError,
  type ChatExecutionService,
} from '../chat-execution/chat-execution-coordinator.js';
import type { TranscriptPageReader } from '../chats/chat-message-reader.js';
import { safeFenceDiagnostic, StaleTranscriptViewError } from '../ledger/errors.js';
import type { ChatMetadata } from '../chats/metadata-store.js';
import { buildChatOrderComparator } from '../chats/chat-order-ranking.js';
import type { AgentRegistryServiceContract } from '../agents/registry.js';
import { createLogger } from '../lib/log.js';
import { readOnlyGitOptions, runGit } from '../git/run.js';
import type {
  CompleteChatHistoryResponse,
  TranscriptReadPurpose,
  UnavailableChatHistoryResponse,
} from '../../common/chat-view.js';
import {
  archivedLogicalCount,
  carryOverRevision,
} from '../chats/carryover-segments.js';
import type {
  ExecutionSettingsPatchRequest,
  ModelPatchRequest,
  CommandAcceptedResponse,
  QueueCommandErrorResponse,
  QueueEntrySteerErrorResponse,
  RunningChatsResponse,
} from '../../common/chat-command-contracts.ts';
import {
  CommandRequestValidationError,
  parseGoalControlCommandRequest,
  parseSteerCommandRequest,
  parseQueueEntrySteerCommandRequest,
  parseAgentInterruptAndSendCommandRequest,
  parseAgentRunCommandRequest,
  parseAgentStopCommandRequest,
  parseCompactCommandRequest,
  parseDeleteChatCommandRequest,
  parseForkChatCommandRequest,
  parseForkRunCommandRequest,
} from '../../common/chat-command-contracts.js';
import { parseSelfHandoffRunCommandRequest } from '../../common/self-handoff-contracts.js';
import {
  parsePermissionDecisionCommandRequest,
  parseProjectPathPatchRequest,
  parseQueueEntryCreateCommandRequest,
  parseQueueEntryDeleteCommandRequest,
  parseQueueEntryMoveCommandRequest,
  parseQueueEntryReplaceCommandRequest,
  parseQueueMutationRequest,
  parseQueueResumeRequest,
  parseStartChatCommandRequest,
} from '../../common/chat-command-contracts.ts';
import type {
  GenerateChatTitleRequest,
  GenerateChatTitleResponse,
} from '../../common/chat-title-contracts.js';
import type { ChatDetailsResponse } from '../../common/chat-details.js';
import type { ChatProcessingActivity } from '../chats/chat-processing-activity.js';
import { createChatSearchRoutes, type ChatSearchDep } from './chat-search-routes.js';
import {
  generateChatTitleFromMessage,
  TitleGenerationError,
} from '../chats/title-generator.js';

const logger = createLogger('routes:chats');
// Bun interprets zero as an unlimited idle window for provider-native forks.
const FORK_REQUEST_TIMEOUT_SECONDS = 0;

interface RequestTimeoutServer {
  timeout(request: Request, seconds: number): void;
}

function isRequestTimeoutServer(value: unknown): value is RequestTimeoutServer {
  return value !== null
    && typeof value === 'object'
    && typeof (value as { timeout?: unknown }).timeout === 'function';
}

function acceptedTurnResponse(result: CommandAcceptedResponse): Response {
  if (!result.chatId || !result.turnId) {
    throw new Error('Accepted agent turn is missing its receipt identity');
  }
  const location = `/api/v1/chats/turn-receipt?chatId=${encodeURIComponent(result.chatId)}&turnId=${encodeURIComponent(result.turnId)}`;
  return Response.json(result, { status: 202, headers: { Location: location } });
}

interface SettingsDep {
  getPinnedChatIds(): string[];
  getNormalChatIds(): string[];
  getArchivedChatIds(): string[];
  getUiSettings(): { chatTitle?: unknown } | null | undefined;
  getChatName(chatId: string): string | null;
  setSessionName(chatId: string, title: string): Promise<unknown>;
  setSessionNameIfAbsent(chatId: string, title: string): Promise<boolean>;
  recordChatStartup(defaults: ChatStartupPreferences): Promise<void>;
  ensureInNormal(chatId: string): Promise<void>;
  removeFromAllOrderLists(chatId: string): Promise<void>;
  removeSessionName(chatId: string): Promise<void>;
  togglePin(chatId: string): Promise<{ isPinned: boolean }>;
  toggleArchive(chatId: string): Promise<{ isArchived: boolean }>;
  reorderChat(
    request: ReorderChatRequest,
    isKnownChat: (chatId: string) => boolean,
  ): Promise<ChatReorderResult>;
  sortChatOrder(compareChatIds: ChatOrderIdComparator): Promise<{ changed: boolean }>;
}

interface PathCacheDep {
  resolveProjectPaths(
    projectPaths: readonly string[],
  ): Promise<Map<string, import('../chats/path-cache.js').ProjectPathStatus>>;
}

interface MetadataDep {
  listAllChatMetadata(): Map<string, ChatMetadata>;
  getChatMetadata(chatId: string): ChatMetadata | null;
  addNewChatMetadata(chatId: string, command: string): void;
}

type QueueDep = ChatExecutionService;
type ChatViewsDep = TranscriptPageReader;
type AgentRegistryDep = AgentRegistryServiceContract;

async function isGitRepository(projectPath: string): Promise<boolean> {
  try {
    const { stdout } = await runGit(projectPath, ['rev-parse', '--is-inside-work-tree'], readOnlyGitOptions());
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

function requireStringField(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || !value.trim()) {
    throw new ValidationDomainError(`${field} is required`);
  }
  return value.trim();
}

function bodyRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
}

function parseCommandRequest<T>(parser: (value: unknown) => T, body: unknown): T {
  try {
    return parser(body);
  } catch (error) {
    if (error instanceof CommandRequestValidationError) {
      throw new ValidationDomainError(error.message);
    }
    throw error;
  }
}

function validatedCommandAttachments(value: unknown) {
  try {
    return validateCommandAttachments(value);
  } catch (error) {
    if (error instanceof AttachmentValidationError) {
      throw new DomainError('VALIDATION_FAILED', error.message, error.status);
    }
    throw error;
  }
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

function optionalStringOrNull(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return typeof value === 'string' ? value : null;
}

function chatSettingsPatchErrorResponse(error: unknown): Response {
  if (error instanceof ModelSelectionError) {
    return jsonError(error.message, 422, 'MODEL_SELECTION_ERROR');
  }
  return jsonErrorFromUnknown(error);
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
  pathCache: PathCacheDep;
  metadata: MetadataDep;
  chatViews: ChatViewsDep;
  agents: AgentRegistryDep;
  commandService: ChatCommandService;
  chatListProjector: import('../chats/chat-list-projector.js').ChatListProjector;
  searchIndex?: ChatSearchDep;
  lastSelectedChat?: LastSelectedChatState;
}

export default function createChatRoutes({
  registry,
  settings,
  recentTitleIcons,
  queue,
  processing,
  pathCache,
  metadata,
  chatViews,
  agents,
  commandService,
  chatListProjector,
  searchIndex,
  lastSelectedChat = new InMemoryLastSelectedChatState(),
}: ChatRouteDeps): RouteMap {
  const commands = commandService;
  const searchRoutes = createChatSearchRoutes({
    registry,
    pathCache,
    chatListProjector,
    searchIndex,
  });

  function validatedLastSelectedChatId(
    rememberedChatId: string | null,
    allSessions: Record<string, unknown>,
    visibleEntries: Map<string, ChatListEntry>,
  ): string | null {
    if (!rememberedChatId) return null;
    if (!(rememberedChatId in allSessions)) {
      lastSelectedChat.clearIf(rememberedChatId);
      return null;
    }
    return visibleEntries.has(rememberedChatId) ? rememberedChatId : null;
  }

  async function validateStartPath(_request: Request, url: URL): Promise<Response> {
    const dirPath = String(url.searchParams.get('path') || '').trim();
    if (!dirPath) {
      return pathValidationError('path is required', 'path_required', 400);
    }

    try {
      const projectPath = await assertRealWithinProjectBase(dirPath);
      const stat = await fs.stat(projectPath);
      if (!stat.isDirectory()) {
        return pathValidationError('Not a directory', 'not_directory');
      }
      const isGitRepo = await isGitRepository(projectPath);
      return Response.json({ valid: true, isGitRepo });
    } catch (error: unknown) {
      if (isProjectBoundaryError(error)) {
        return pathValidationError('Path is outside the allowed base directory', 'outside_base_dir');
      }
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        return pathValidationError('Path does not exist', 'path_not_found');
      }
      if (err.code === 'EACCES' || err.code === 'EPERM') {
        return pathValidationError('Permission denied', 'permission_denied');
      }
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
      const statuses = await pathCache.resolveProjectPaths(sessionEntries.map(([, session]) => session.projectPath));
      const entryMap = await chatListProjector.buildMany(sessionEntries, statuses);
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
        entryMap,
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

  async function postStartSession(body: unknown): Promise<Response> {
    try {
      const input = parseCommandRequest(parseStartChatCommandRequest, body);
      const images = validatedCommandAttachments(input.images);
      const result = await commands.submitStart({ ...input, images });
      return acceptedTurnResponse(result);
    } catch (error: unknown) {
      if (error instanceof CommandValidationError) {
        return jsonError(error.message, error.status, error.code, error.retryable);
      }
      if (error instanceof ModelSelectionError) {
        return jsonError((error as Error).message, 422);
      }
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
      if (error instanceof CommandValidationError) {
        return jsonError(error.message, error.status, error.code, error.retryable);
      }
      return jsonErrorFromUnknown(error);
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
    if (!registry.getChat(chatId)) {
      return jsonError('Session not found', 404, 'SESSION_NOT_FOUND');
    }

    lastSelectedChat.setLastSelectedChatId(chatId);
    return Response.json({
      success: true,
      lastSelectedChatId: chatId,
    } satisfies SetLastSelectedChatResponse);
  }

  async function getMessages(_request: Request, url: URL): Promise<Response> {
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
        undefined,
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
      const session = registry.getChat(chatId);
      if (!session) {
        return jsonError('Session not found', 404, 'SESSION_NOT_FOUND');
      }

      const result = await settings.togglePin(chatId);
      return Response.json({ success: true, isPinned: result.isPinned });
    } catch (error: unknown) {
      return jsonErrorFromUnknown(error);
    }
  }

  async function postToggleArchive(body: unknown, _request: Request, url: URL): Promise<Response> {
    const chatId = chatIdFromBodyOrQuery(body, url);
    if (!chatId) return jsonError('chatId is required', 400);

    try {
      const session = registry.getChat(chatId);
      if (!session) {
        return jsonError('Session not found', 404, 'SESSION_NOT_FOUND');
      }

      const result = await settings.toggleArchive(chatId);
      return Response.json({ success: true, isArchived: result.isArchived });
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
      if (!registry.getChat(request.chatId)) {
        return jsonError('Chat not found', 404, 'SESSION_NOT_FOUND', false);
      }
      if (
        request.placement.kind === 'relative'
        && !registry.getChat(request.placement.referenceChatId)
      ) {
        return jsonError('Reference chat not found', 404, 'SESSION_NOT_FOUND', false);
      }

      const result = await settings.reorderChat(
        request,
        (chatId) => registry.getChat(chatId) != null,
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
      const result = await settings.sortChatOrder(compareChatIds);
      return Response.json({
        success: true,
        sortKey: request.sortKey,
        changed: result.changed,
      } satisfies SortChatOrderResponse);
    } catch (error: unknown) {
      return jsonErrorFromUnknown(error);
    }
  }

  async function patchChatTags(body: Record<string, unknown>): Promise<Response> {
    try {
      const chatId = String(body.chatId || '').trim();
      if (!chatId) {
        return jsonError('chatId is required', 400);
      }

      const session = registry.getChat(chatId);
      if (!session) {
        return jsonError('Session not found', 404, 'SESSION_NOT_FOUND');
      }

      const rawTags = Array.isArray(body.tags) ? body.tags : [];
      const tags = normalizeTags(rawTags);

      registry.updateChat(chatId, { tags });
      return Response.json({ success: true, chatId, tags });
    } catch (error: unknown) {
      return jsonErrorFromUnknown(error);
    }
  }

  async function postForkChat(
    body: unknown,
    request: Request,
    _url: URL,
    server?: unknown,
  ): Promise<Response> {
    try {
      const input = parseCommandRequest(parseForkChatCommandRequest, body);
      if (isRequestTimeoutServer(server)) server.timeout(request, FORK_REQUEST_TIMEOUT_SECONDS);
      const result = await commands.forkChat(input, request.signal);

      return Response.json(result);
    } catch (error: unknown) {
      if (error instanceof CommandValidationError) {
        return jsonError(error.message, error.status, error.code, error.retryable);
      }
      return jsonErrorFromUnknown(error);
    }
  }

  async function postRunChat(
    body: unknown,
    request: Request,
    _url: URL,
    server?: unknown,
  ): Promise<Response> {
    try {
      const input = parseCommandRequest(parseAgentRunCommandRequest, body);
      const images = validatedCommandAttachments(input.images);
      if (input.handoff && isRequestTimeoutServer(server)) {
        server.timeout(request, AGENT_HANDOFF_REQUEST_TIMEOUT_SECONDS);
      }
      const result = await commands.submitRun({ ...input, images });

      return acceptedTurnResponse(result);
    } catch (error: unknown) {
      if (error instanceof CommandExecutionControlError) {
        const body: QueueCommandErrorResponse = {
          success: false,
          error: error.message,
          errorCode: error.code,
          retryable: error.retryable,
          control: toClientChatExecutionControlState(error.control),
        };
        return Response.json(body, { status: error.status });
      }
      if (error instanceof CommandValidationError) {
        return jsonError(error.message, error.status, error.code, error.retryable);
      }
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
        projectPath: session.projectPath,
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

  async function postForkRunChat(
    body: unknown,
    request: Request,
    _url: URL,
    server?: unknown,
  ): Promise<Response> {
    try {
      const input = parseCommandRequest(parseForkRunCommandRequest, body);
      if (isRequestTimeoutServer(server)) server.timeout(request, FORK_REQUEST_TIMEOUT_SECONDS);
      const images = validatedCommandAttachments(input.images);
      const result = await commands.submitForkRun({ ...input, images });

      return Response.json(result, { status: 202 });
    } catch (error: unknown) {
      if (error instanceof CommandValidationError) {
        return jsonError(error.message, error.status, error.code, error.retryable);
      }
      return jsonErrorFromUnknown(error);
    }
  }

  async function postSelfHandoffRunChat(body: unknown): Promise<Response> {
    try {
      const input = parseCommandRequest(parseSelfHandoffRunCommandRequest, body);
      const images = validatedCommandAttachments(input.images);
      const result = await commands.submitSelfHandoffRun({ ...input, images });

      return Response.json(result, { status: 202 });
    } catch (error: unknown) {
      if (error instanceof CommandValidationError) {
        return jsonError(error.message, error.status, error.code, error.retryable);
      }
      return jsonErrorFromUnknown(error);
    }
  }

  async function getRunningChats(): Promise<Response> {
    const response: RunningChatsResponse = {
      sessions: agents.getRunningSessions(),
    };
    return Response.json(response);
  }

  async function getQueue(_request: Request, url: URL): Promise<Response> {
    const chatId = url.searchParams.get('chatId');
    if (!chatId) return jsonError('chatId query parameter is required', 400);
    if (!registry.getChat(chatId)) return jsonError('Session not found', 404, 'SESSION_NOT_FOUND');
    const control = toClientChatExecutionControlState(await queue.readChatExecutionControl(chatId));
    return Response.json({ success: true, chatId, control });
  }

  function queueControlErrorResponse(
    error: QueueEntryMutationError
      | QueuePauseChangedError,
  ): Response {
    const body: QueueCommandErrorResponse = {
      success: false,
      error: error.message,
      errorCode: error.code,
      retryable: error.retryable,
      control: toClientChatExecutionControlState(error.control),
    };
    return Response.json(body, { status: error.status });
  }

  async function postQueueEntryCreate(body: unknown): Promise<Response> {
    try {
      const input = parseCommandRequest(parseQueueEntryCreateCommandRequest, body);
      const result = await commands.submitQueueEntryCreate(input);
      return Response.json(result, { status: 202 });
    } catch (error: unknown) {
      if (error instanceof CommandValidationError) {
        return jsonError(error.message, error.status, error.code, error.retryable);
      }
      if (error instanceof QueueEntryMutationError) return queueControlErrorResponse(error);
      return jsonErrorFromUnknown(error);
    }
  }

  async function putQueueEntry(body: unknown): Promise<Response> {
    try {
      const input = parseCommandRequest(parseQueueEntryReplaceCommandRequest, body);
      const result = await commands.submitQueueEntryReplace(input);
      return Response.json(result);
    } catch (error: unknown) {
      if (error instanceof CommandValidationError) {
        return jsonError(error.message, error.status, error.code, error.retryable);
      }
      if (error instanceof QueueEntryMutationError) return queueControlErrorResponse(error);
      return jsonErrorFromUnknown(error);
    }
  }

  async function deleteQueueEntry(body: unknown): Promise<Response> {
    try {
      const input = parseCommandRequest(parseQueueEntryDeleteCommandRequest, body);
      const result = await commands.submitQueueEntryDelete(input);
      return Response.json(result);
    } catch (error: unknown) {
      if (error instanceof CommandValidationError) {
        return jsonError(error.message, error.status, error.code, error.retryable);
      }
      if (error instanceof QueueEntryMutationError) return queueControlErrorResponse(error);
      return jsonErrorFromUnknown(error);
    }
  }

  async function putQueueEntryMove(body: unknown): Promise<Response> {
    try {
      const input = parseCommandRequest(parseQueueEntryMoveCommandRequest, body);
      const result = await commands.submitQueueEntryMove(input);
      return Response.json(result);
    } catch (error: unknown) {
      if (error instanceof CommandValidationError) {
        return jsonError(error.message, error.status, error.code, error.retryable);
      }
      if (error instanceof QueueEntryMutationError) return queueControlErrorResponse(error);
      return jsonErrorFromUnknown(error);
    }
  }

  async function postGoalControl(body: unknown): Promise<Response> {
    try {
      const input = parseCommandRequest(parseGoalControlCommandRequest, body);
      const result = await commands.submitGoalControl(input);
      return Response.json(result, { status: 202 });
    } catch (error: unknown) {
      if (error instanceof CommandValidationError) {
        return jsonError(error.message, error.status, error.code, error.retryable);
      }
      if (error instanceof GoalControlDeliveryError) {
        logger.error('queue: goal control delivery failed:', error.cause);
      }
      return jsonErrorFromUnknown(error);
    }
  }

  async function postSteer(body: unknown): Promise<Response> {
    try {
      const input = parseCommandRequest(parseSteerCommandRequest, body);
      const result = await commands.submitSteer(input);
      return Response.json(result, { status: 202 });
    } catch (error: unknown) {
      if (error instanceof CommandValidationError) {
        return jsonError(error.message, error.status, error.code, error.retryable);
      }
      return jsonErrorFromUnknown(error);
    }
  }

  async function postQueueEntrySteer(body: unknown): Promise<Response> {
    let chatId: string | null = null;
    try {
      const input = parseCommandRequest(parseQueueEntrySteerCommandRequest, body);
      chatId = input.chatId;
      const result = await commands.submitQueueEntrySteer(input);
      return Response.json(result, { status: 202 });
    } catch (error: unknown) {
      if (error instanceof QueueEntrySteerError && chatId) {
        const control = error.control
          ? toClientChatExecutionControlState(error.control)
          : undefined;
        const serverInstanceId = control?.serverInstanceId
          ?? (await queue.readChatExecutionControl(chatId)).serverInstanceId;
        const response: QueueEntrySteerErrorResponse = {
          success: false,
          error: error.message,
          errorCode: error.code,
          retryable: error.retryable,
          deliveryOutcome: error.deliveryOutcome,
          serverInstanceId,
          ...(control ? { control } : {}),
        };
        return Response.json(response, { status: error.status });
      }
      if (error instanceof CommandValidationError) {
        return jsonError(error.message, error.status, error.code, error.retryable);
      }
      return jsonErrorFromUnknown(error);
    }
  }

  async function postQueueMutation(body: unknown, action: 'clear' | 'pause' | 'resume'): Promise<Response> {
    try {
      const input = action === 'resume'
        ? parseCommandRequest(parseQueueResumeRequest, body)
        : parseCommandRequest(parseQueueMutationRequest, body);
      const result = await commands.mutateQueue({ ...input, action });
      return Response.json(result);
    } catch (error: unknown) {
      if (error instanceof CommandValidationError) {
        return jsonError(error.message, error.status, error.code, error.retryable);
      }
      if (error instanceof QueuePauseChangedError) return queueControlErrorResponse(error);
      return jsonErrorFromUnknown(error);
    }
  }

  async function postPermissionDecision(body: unknown): Promise<Response> {
    try {
      const input = parseCommandRequest(parsePermissionDecisionCommandRequest, body);
      const result = await commands.submitPermissionDecision(input);
      return Response.json(result);
    } catch (error: unknown) {
      if (error instanceof CommandValidationError) {
        return jsonError(error.message, error.status, error.code, error.retryable);
      }
      return jsonErrorFromUnknown(error);
    }
  }

  async function postStopChat(body: unknown): Promise<Response> {
    try {
      const input = parseCommandRequest(parseAgentStopCommandRequest, body);
      const result = await commands.submitStop(input);
      return Response.json(result);
    } catch (error: unknown) {
      if (error instanceof CommandValidationError) {
        return jsonError(error.message, error.status, error.code, error.retryable);
      }
      return jsonErrorFromUnknown(error);
    }
  }

  async function postInterruptAndSend(body: unknown): Promise<Response> {
    try {
      const input = parseCommandRequest(parseAgentInterruptAndSendCommandRequest, body);
      const result = await commands.submitInterruptAndSend(input);
      return Response.json(result);
    } catch (error: unknown) {
      if (error instanceof CommandValidationError) {
        return jsonError(error.message, error.status, error.code, error.retryable);
      }
      return jsonErrorFromUnknown(error);
    }
  }

  async function postCompactChat(body: unknown): Promise<Response> {
    try {
      const input = parseCommandRequest(parseCompactCommandRequest, body);
      const result = await commands.submitCompact(input);
      return Response.json(result, { status: 202 });
    } catch (error: unknown) {
      if (error instanceof CommandValidationError) {
        return jsonError(error.message, error.status, error.code, error.retryable);
      }
      return jsonErrorFromUnknown(error);
    }
  }

  async function patchExecutionSettings(
    body: ExecutionSettingsPatchRequest & Record<string, unknown>,
  ): Promise<Response> {
    try {
      const chatId = requireStringField(body, 'chatId');
      const chat = registry.getChat(chatId);
      if (!chat) return jsonError('Session not found', 404, 'SESSION_NOT_FOUND');
      const patch: AgentSessionSettingsPatch = {};
      if (body.permissionMode !== undefined) {
        patch.permissionMode = normalizePermissionMode(body.permissionMode);
      }
      if (body.thinkingMode !== undefined) {
        patch.thinkingMode = normalizeThinkingMode(body.thinkingMode);
      }
      if (body.agentSettingsPatch !== undefined) {
        if (!body.agentSettingsPatch || typeof body.agentSettingsPatch !== 'object' || Array.isArray(body.agentSettingsPatch)) {
          return jsonError('agentSettingsPatch must be an object', 400, 'VALIDATION_FAILED');
        }
        patch.agentSettingsPatch = body.agentSettingsPatch as JsonObject;
      }
      const hasPatch = Object.keys(patch).length > 0;
      const updated = hasPatch
        ? await agents.updateSessionSettings(chatId, patch)
        : chat;
      if (hasPatch) searchIndex?.catalogMayHaveChanged(chatId);
      return Response.json({
        success: true,
        chatId,
        permissionMode: updated.permissionMode,
        thinkingMode: updated.thinkingMode,
        agentSettings: updated.agentSettingsById?.[updated.agentId] ?? chat.agentSettingsById[chat.agentId],
      });
    } catch (error: unknown) {
      return chatSettingsPatchErrorResponse(error);
    }
  }

  async function patchModel(body: ModelPatchRequest & Record<string, unknown>): Promise<Response> {
    try {
      const chatId = requireStringField(body, 'chatId');
      const model = requireStringField(body, 'model');
      if (!registry.getChat(chatId)) return jsonError('Session not found', 404, 'SESSION_NOT_FOUND');
      const apiProviderId = optionalStringOrNull(body.apiProviderId);
      const modelEndpointId = optionalStringOrNull(body.modelEndpointId);
      const modelProtocol = optionalStringOrNull(body.modelProtocol);
      const patch: AgentSessionSettingsPatch = { model };
      if (apiProviderId !== undefined) patch.apiProviderId = apiProviderId;
      if (modelEndpointId !== undefined) patch.modelEndpointId = modelEndpointId;
      if (modelProtocol !== undefined)
        patch.modelProtocol = modelProtocol as AgentSessionSettingsPatch['modelProtocol'];
      await agents.updateSessionSettings(chatId, patch);
      searchIndex?.catalogMayHaveChanged(chatId);
      return Response.json({ success: true, chatId, ...patch });
    } catch (error: unknown) {
      return chatSettingsPatchErrorResponse(error);
    }
  }

  async function patchProjectPath(body: unknown): Promise<Response> {
    try {
      const input = parseCommandRequest(parseProjectPathPatchRequest, body);
      const result = await commands.updateProjectPath(input);
      return Response.json(result);
    } catch (error: unknown) {
      if (error instanceof CommandValidationError) {
        return jsonError(error.message, error.status, error.code, error.retryable);
      }
      return jsonErrorFromUnknown(error);
    }
  }

  return {
    '/api/v1/chats': {
      GET: getChats,
      DELETE: withJsonBody(deleteSessionHandler),
    },
    '/api/v1/chats/last-selected': { PUT: withJsonBody(putLastSelectedChat) },
    '/api/v1/chats/start': { POST: withJsonBody(postStartSession) },
    '/api/v1/chats/title/generate': {
      POST: withJsonBody(postGenerateChatTitle),
    },
    '/api/v1/chats/run': { POST: withJsonBody(postRunChat) },
    '/api/v1/chats/validate-start': { GET: validateStartPath },
    '/api/v1/chats/fork': { POST: withJsonBody(postForkChat) },
    '/api/v1/chats/fork-run': { POST: withJsonBody(postForkRunChat) },
    '/api/v1/chats/handoff-run': { POST: withJsonBody(postSelfHandoffRunChat) },
    '/api/v1/chats/compact': { POST: withJsonBody(postCompactChat) },
    '/api/v1/chats/messages': { GET: getMessages },
    '/api/v1/chats/search': { POST: withJsonBody(searchRoutes.postSearchChats) },
    '/api/v1/chats/search/navigate': { POST: withJsonBody(searchRoutes.postSearchNavigate) },
    '/api/v1/chats/search/status': { GET: searchRoutes.getSearchStatus },
    '/api/v1/chats/running': { GET: getRunningChats },
    '/api/v1/chats/queue': { GET: getQueue },
    '/api/v1/chats/queue/entries': {
      POST: withJsonBody(postQueueEntryCreate),
      PUT: withJsonBody(putQueueEntry),
      DELETE: withJsonBody(deleteQueueEntry),
    },
    '/api/v1/chats/queue/entries/move': {
      PUT: withJsonBody(putQueueEntryMove),
    },
    '/api/v1/chats/goal-control': { POST: withJsonBody(postGoalControl) },
    '/api/v1/chats/steer': { POST: withJsonBody(postSteer) },
    '/api/v1/chats/queue/entries/steer': { POST: withJsonBody(postQueueEntrySteer) },
    '/api/v1/chats/queue/clear': {
      POST: withJsonBody((body: unknown) => postQueueMutation(body, 'clear')),
    },
    '/api/v1/chats/queue/pause': {
      POST: withJsonBody((body: unknown) => postQueueMutation(body, 'pause')),
    },
    '/api/v1/chats/queue/resume': {
      POST: withJsonBody((body: unknown) => postQueueMutation(body, 'resume')),
    },
    '/api/v1/chats/permissions/decision': {
      POST: withJsonBody(postPermissionDecision),
    },
    '/api/v1/chats/stop': { POST: withJsonBody(postStopChat) },
    '/api/v1/chats/interrupt-and-send': { POST: withJsonBody(postInterruptAndSend) },
    '/api/v1/chats/execution-settings': {
      PATCH: withJsonBody(patchExecutionSettings),
    },
    '/api/v1/chats/model': { PATCH: withJsonBody(patchModel) },
    '/api/v1/chats/project-path': { PATCH: withJsonBody(patchProjectPath) },
    '/api/v1/chats/details': { GET: getChatDetails },
    '/api/v1/chats/pin': { POST: withJsonBody(postTogglePin) },
    '/api/v1/chats/archive': { POST: withJsonBody(postToggleArchive) },
    '/api/v1/chats/read': { POST: withJsonBody(postMarkRead) },
    '/api/v1/chats/reorder': { POST: withJsonBody(postReorderChat) },
    '/api/v1/chats/sort': { POST: withJsonBody(postSortChatOrder) },
    '/api/v1/chats/tags': { PATCH: withJsonBody(patchChatTags) },
  };
}
