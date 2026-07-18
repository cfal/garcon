// /api/chats/* route handlers. Provides CRUD for the session registry
// and dispatches message reads to the appropriate agent parser.

import { promises as fs } from 'fs';
import { withJsonBody } from '../lib/json-route.js';
import type { IChatRegistry } from '../chats/store.js';
import {
  normalizeAmpAgentMode,
  normalizeClaudeThinkingMode,
  normalizePermissionMode,
  normalizeThinkingModeForAgent,
} from '../../common/chat-modes.js';
import { ModelSelectionError } from '../api-providers/endpoint-resolver.js';
import type { AgentSessionSettingsPatch } from '../agents/session-types.js';
import { CommandValidationError, runOptionsFromCommandRequest } from '../commands/chat-command-service.js';
import type { ChatCommandService } from '../commands/chat-command-service.js';
import { normalizeStoredQueueState, toClientQueueState } from '../queue-state.ts';
import { normalizeTags } from '../../common/tags.ts';
import type {
  ChatListEntry,
  ChatListResponse,
  ChatOrderGroup,
  SetLastSelectedChatRequest,
  SetLastSelectedChatResponse,
} from '../../common/chat-list.js';
import { CHAT_MESSAGES_MAX_LIMIT, parsePagination } from '../lib/pagination.js';
import { assertRealWithinProjectBase, isProjectBoundaryError } from '../lib/path-boundary.js';
import { jsonError, jsonErrorFromUnknown } from '../lib/http-error.js';
import { ActiveInputDeliveryError, ValidationDomainError } from '../lib/domain-error.js';
import type { ReorderResult } from '../settings/types.js';
import type { RouteMap } from '../lib/http-route-types.js';
import { InMemoryLastSelectedChatState, type LastSelectedChatState } from '../chats/last-selected-chat-state.js';
import { QueueEntryMutationError, QueuePauseChangedError, type ChatQueueService } from '../queue.js';
import type { ChatViewPageReader } from '../chats/chat-message-reader.js';
import type { ChatMetadata } from '../chats/metadata-store.js';
import type { PendingUserInputServiceContract } from '../chats/pending-user-input-service.js';
import type { PendingUserInputRecoveryCoordinator } from '../chats/pending-user-input-recovery.js';
import type { AgentRegistryServiceContract } from '../agents/registry.js';
import { AgentSwitchError, type AgentSwitchService } from '../agents/agent-switch-service.js';
import { createLogger } from '../lib/log.js';
import { readOnlyGitOptions, runGit } from '../git/run.js';

const logger = createLogger('routes:chats');
const MAX_SEARCH_QUERY_CHARS = 4_096;
const MAX_SEARCH_TEXT_TOKEN_CHARS = 1_024;
const MAX_SEARCH_TEXT_CHARS = 8_192;
const MAX_SEARCH_CHAT_IDS = 10_000;
const MAX_SEARCH_CHAT_ID_CHARS = 512;
import type {
  AgentInterruptAndSendCommandRequest,
  AgentRunCommandRequest,
  AgentStopCommandRequest,
  CompactCommandRequest,
  ExecutionSettingsPatchRequest,
  ForkRunCommandRequest,
  ModelPatchRequest,
  AgentModelPatchRequest,
  PermissionDecisionCommandRequest,
  ProjectPathPatchRequest,
  ActiveInputCommandRequest,
  QueueEntryCreateCommandRequest,
  QueueEntryDeleteCommandRequest,
  QueueEntryReplaceCommandRequest,
  QueueCommandErrorResponse,
  QueueMutationRequest,
  QueuePauseRequest,
  QueueResumeRequest,
  RunningChatsResponse,
  StartChatCommandRequest,
} from '../../common/chat-command-contracts.ts';
import type {
  GenerateChatTitleRequest,
  GenerateChatTitleResponse,
} from '../../common/chat-title-contracts.js';
import type {
  ChatSearchRequest,
  ChatSearchResponse,
} from '../../common/chat-search.js';
import { CHAT_SEARCH_MAX_TERMS, CHAT_SEARCH_MAX_WORDS } from '../../common/chat-search.js';
import {
  generateChatTitleFromMessage,
  TitleGenerationError,
} from '../chats/title-generator.js';

interface SettingsDep {
  getPinnedChatIds(): string[];
  getNormalChatIds(): string[];
  getArchivedChatIds(): string[];
  getUiSettings(): { chatTitle?: unknown } | null | undefined;
  getChatName(chatId: string): string | null;
  setSessionName(chatId: string, title: string): Promise<unknown>;
  recordChatStartup(defaults: Record<string, unknown>): Promise<void>;
  ensureInNormal(chatId: string): Promise<void>;
  removeFromAllOrderLists(chatId: string): Promise<void>;
  removeSessionName(chatId: string): Promise<void>;
  togglePin(chatId: string): Promise<{ isPinned: boolean }>;
  toggleArchive(chatId: string): Promise<{ isArchived: boolean }>;
  reorderWindow(list: string, oldOrder: string[], newOrder: string[]): Promise<ReorderResult>;
  reorderRelative(chatId: string, refId: string, mode: string): Promise<ReorderResult>;
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

type QueueDep = ChatQueueService;
type ChatViewsDep = ChatViewPageReader;
type AgentRegistryDep = AgentRegistryServiceContract;
type PendingInputsDep = PendingUserInputServiceContract;
type PendingInputRecoveryDep = Pick<PendingUserInputRecoveryCoordinator, 'reconcileChat'>;

interface ChatSearchDep {
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

function requireContentField(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || !value.trim()) {
    throw new ValidationDomainError(`${field} is required`);
  }
  return value;
}

function bodyRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
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

function parseBeforeSeq(value: string | null): number | Response | undefined {
  if (value === null || value.trim() === '') return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return jsonError('beforeSeq must be a positive integer', 400, 'VALIDATION_FAILED');
  }
  return parsed;
}

function optionalStringOrNull(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return typeof value === 'string' ? value : null;
}

function chatSettingsPatchErrorResponse(error: unknown): Response {
  if (error instanceof AgentSwitchError) {
    return jsonError(error.message, error.status, error.code, error.retryable);
  }
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

function stringArrayOrNull(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null;
}

function optionalStringArrayField(body: Record<string, unknown>, field: string): string[] | undefined {
  if (body[field] === undefined) return undefined;
  const values = stringArrayOrNull(body[field]);
  if (!values) throw new ValidationDomainError(`${field} must be an array of strings`);
  return values.map((value) => value.trim()).filter(Boolean);
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

function parseSearchRequest(body: unknown): ChatSearchRequest {
  const input = bodyRecord(body);
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
  pathCache: PathCacheDep,
  chatListProjector: import('../chats/chat-list-projector.js').ChatListProjector,
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

interface ChatRouteDeps {
  registry: IChatRegistry;
  settings: SettingsDep;
  queue: QueueDep;
  pathCache: PathCacheDep;
  metadata: MetadataDep;
  chatViews: ChatViewsDep;
  agents: AgentRegistryDep;
  pendingInputs: PendingInputsDep;
  pendingInputRecovery: PendingInputRecoveryDep;
  commandService: ChatCommandService;
  chatListProjector: import('../chats/chat-list-projector.js').ChatListProjector;
  agentSwitch: AgentSwitchService;
  searchIndex?: ChatSearchDep;
  lastSelectedChat?: LastSelectedChatState;
}

export default function createChatRoutes({
  registry,
  settings,
  queue,
  pathCache,
  metadata,
  chatViews,
  agents,
  pendingInputs,
  pendingInputRecovery,
  commandService,
  chatListProjector,
  agentSwitch,
  searchIndex,
  lastSelectedChat = new InMemoryLastSelectedChatState(),
}: ChatRouteDeps): RouteMap {
  const commands = commandService;

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

  async function postStartSession(body: Partial<StartChatCommandRequest> & Record<string, unknown>): Promise<Response> {
    try {
      if ('options' in body) {
        return jsonError('options is not supported', 400, 'VALIDATION_FAILED', false);
      }
      const result = await commands.submitStart({
        chatId: String(body.chatId || ''),
        clientRequestId: requireStringField(body, 'clientRequestId'),
        clientMessageId: requireStringField(body, 'clientMessageId'),
        agentId: typeof body.agentId === 'string' ? body.agentId : '',
        projectPath: String(body.projectPath || ''),
        command: String(body.command || ''),
        model: typeof body.model === 'string' ? body.model : '',
        apiProviderId: typeof body.apiProviderId === 'string' ? body.apiProviderId : null,
        modelEndpointId: typeof body.modelEndpointId === 'string' ? body.modelEndpointId : null,
        modelProtocol:
          typeof body.modelProtocol === 'string'
            ? (body.modelProtocol as StartChatCommandRequest['modelProtocol'])
            : null,
        permissionMode: body.permissionMode,
        thinkingMode: body.thinkingMode,
        claudeThinkingMode: body.claudeThinkingMode,
        ampAgentMode: body.ampAgentMode,
        tags: Array.isArray(body.tags) ? body.tags : undefined,
        images: body.images,
      });
      return Response.json(result, { status: 202 });
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
      await commandService.deleteChat({ chatId });
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

      const { limit } = parsePagination(url.searchParams.get('limit'), null, {
        maxLimit: CHAT_MESSAGES_MAX_LIMIT,
      });
      const beforeSeqRaw = url.searchParams.get('beforeSeq');
      const beforeSeq = parseBeforeSeq(beforeSeqRaw);
      if (beforeSeq instanceof Response) return beforeSeq;

      const page = await chatViews.getOrCreatePage(chatId, limit, beforeSeq);
      await pendingInputs.reconcileRetainedHistory(chatId);
      await pendingInputRecovery.reconcileChat(chatId);
      return Response.json({
        chatId,
        generationId: page.generationId,
        messages: page.messages,
        lastSeq: page.lastSeq,
        pageOldestSeq: page.pageOldestSeq,
        hasMore: page.hasMore,
        limit,
        pendingUserInputs: pendingInputs.listForTransport(chatId),
      });
    } catch (error: unknown) {
      logger.error(`sessions: error reading messages for ${chatId}:`, (error as Error).message);
      return jsonErrorFromUnknown(error);
    }
  }

  async function postSearchChats(body: unknown): Promise<Response> {
    try {
      if (!searchIndex) return jsonError('Chat search index is not available', 503, 'SEARCH_INDEX_UNAVAILABLE');
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
      if (
        error
        && typeof error === 'object'
        && 'code' in error
        && (error.code === 'TRANSCRIPT_SEARCH_DISABLED'
          || error.code === 'SEARCH_INDEX_UNAVAILABLE'
          || error.code === 'SEARCH_INDEX_BUSY')
      ) {
        const typed = error as { code: string; message?: string; retryable?: boolean };
        const status = typed.code === 'TRANSCRIPT_SEARCH_DISABLED' ? 409 : 503;
        return jsonError(
          typed.message ?? 'Transcript search is unavailable',
          status,
          typed.code,
          typed.retryable ?? status === 503,
        );
      }
      if (error instanceof ValidationDomainError) {
        return jsonError(error.message, error.status, error.code, error.retryable);
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
      return Response.json({
        chatId,
        firstMessage: meta?.firstMessage || '',
        createdAt: meta?.createdAt || null,
        lastActivityAt: meta?.lastActivity || null,
        agentSessionId: session.agentSessionId || null,
        nativePath: session.nativePath || null,
      });
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

  async function postMarkRead(body: Record<string, unknown>): Promise<Response> {
    try {
      const entries = Array.isArray(body.entries) ? body.entries : [];
      if (entries.length === 0) {
        return Response.json({ success: true, results: [] });
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

      return Response.json({ success: true, results });
    } catch (error: unknown) {
      return jsonErrorFromUnknown(error);
    }
  }

  async function postReorderChats(body: Record<string, unknown>): Promise<Response> {
    try {
      const list = typeof body?.list === 'string' ? body.list : '';
      const oldOrder = stringArrayOrNull(body?.oldOrder);
      const newOrder = stringArrayOrNull(body?.newOrder);

      if (!['pinned', 'normal', 'archived'].includes(list)) {
        return jsonError('list must be "pinned", "normal", or "archived"', 400);
      }
      if (!oldOrder || !newOrder) {
        return jsonError('oldOrder and newOrder must be arrays', 400);
      }

      const result = await settings.reorderWindow(list, oldOrder, newOrder);
      if (!result.success) {
        return jsonError(result.error, result.status, result.errorCode);
      }

      return Response.json({ success: true });
    } catch (error: unknown) {
      return jsonErrorFromUnknown(error);
    }
  }

  async function postReorderQuick(body: Record<string, unknown>): Promise<Response> {
    try {
      const chatId = typeof body?.chatId === 'string' ? body.chatId.trim() : '';
      const chatIdAbove = typeof body?.chatIdAbove === 'string' ? body.chatIdAbove.trim() : '';
      const chatIdBelow = typeof body?.chatIdBelow === 'string' ? body.chatIdBelow.trim() : '';

      if (!chatId) {
        return jsonError('chatId is required', 400);
      }
      if ((chatIdAbove && chatIdBelow) || (!chatIdAbove && !chatIdBelow)) {
        return jsonError('Exactly one of chatIdAbove or chatIdBelow must be provided', 400);
      }

      const refId = chatIdAbove || chatIdBelow;
      const mode = chatIdAbove ? 'below' : 'above';

      const session = registry.getChat(chatId);
      if (!session) return jsonError('Chat not found', 404, 'SESSION_NOT_FOUND');

      const refSession = registry.getChat(refId);
      if (!refSession) return jsonError('Reference chat not found', 404, 'SESSION_NOT_FOUND');

      const result = await settings.reorderRelative(chatId, refId, mode);
      if (!result.success) {
        return jsonError(result.error, result.status, result.errorCode);
      }

      return Response.json({ success: true });
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

  async function postForkChat(body: Record<string, unknown>): Promise<Response> {
    try {
      const sourceChatId = typeof body.sourceChatId === 'string' ? body.sourceChatId : '';
      const chatId = typeof body.chatId === 'string' ? body.chatId : '';

      const result = await commands.forkChat({
        sourceChatId,
        chatId,
        ...(body.upToSeq == null ? {} : { upToSeq: body.upToSeq }),
      });

      return Response.json(result);
    } catch (error: unknown) {
      if (error instanceof CommandValidationError) {
        return jsonError(error.message, error.status, error.code, error.retryable);
      }
      return jsonErrorFromUnknown(error);
    }
  }

  async function postRunChat(body: Partial<AgentRunCommandRequest> & Record<string, unknown>): Promise<Response> {
    try {
      const clientRequestId = requireStringField(body, 'clientRequestId');
      const clientMessageId = requireStringField(body, 'clientMessageId');
      const chatId = requireStringField(body, 'chatId');
      const command = typeof body.command === 'string' ? body.command : '';
      const hasImages = Array.isArray(body.images) && body.images.length > 0;
      if (!command.trim() && !hasImages) {
        return jsonError('command or images are required', 400);
      }
      const session = registry.getChat(chatId);
      if (!session) return jsonError('Session not found', 404, 'SESSION_NOT_FOUND');

      const options = runOptionsFromCommandRequest(body as AgentRunCommandRequest);
      const result = await commands.submitRun({
        chatId,
        command,
        images: body.images,
        clientRequestId,
        clientMessageId,
        options,
      });

      return Response.json(result, { status: 202 });
    } catch (error: unknown) {
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

  async function postForkRunChat(body: Partial<ForkRunCommandRequest> & Record<string, unknown>): Promise<Response> {
    try {
      const clientRequestId = requireStringField(body, 'clientRequestId');
      const clientMessageId = requireStringField(body, 'clientMessageId');
      const sourceChatId = typeof body.sourceChatId === 'string' ? body.sourceChatId : '';
      const chatId = typeof body.chatId === 'string' ? body.chatId : '';
      const command = requireStringField(body, 'command');

      const options = runOptionsFromCommandRequest(body as ForkRunCommandRequest);
      const result = await commands.submitForkRun({
        sourceChatId,
        chatId,
        command,
        images: body.images,
        clientRequestId,
        clientMessageId,
        options,
      });

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
    const state = toClientQueueState(normalizeStoredQueueState(await queue.readChatQueue(chatId)));
    return Response.json({ success: true, chatId, queue: state });
  }

  function queueEntryErrorResponse(error: QueueEntryMutationError | QueuePauseChangedError): Response {
    const body: QueueCommandErrorResponse = {
      success: false,
      error: error.message,
      errorCode: error.code,
      retryable: error.retryable,
      queue: toClientQueueState(error.queue),
    };
    return Response.json(body, { status: error.status });
  }

  async function postQueueEntryCreate(
    body: Partial<QueueEntryCreateCommandRequest> & Record<string, unknown>,
  ): Promise<Response> {
    try {
      const clientRequestId = requireStringField(body, 'clientRequestId');
      const chatId = requireStringField(body, 'chatId');
      const content = requireContentField(body, 'content');
      const result = await commands.submitQueueEntryCreate({
        chatId,
        content,
        clientRequestId,
      });
      return Response.json(result, { status: 202 });
    } catch (error: unknown) {
      if (error instanceof CommandValidationError) {
        return jsonError(error.message, error.status, error.code, error.retryable);
      }
      if (error instanceof QueueEntryMutationError) return queueEntryErrorResponse(error);
      return jsonErrorFromUnknown(error);
    }
  }

  async function putQueueEntry(
    body: Partial<QueueEntryReplaceCommandRequest> & Record<string, unknown>,
  ): Promise<Response> {
    try {
      const clientRequestId = requireStringField(body, 'clientRequestId');
      const chatId = requireStringField(body, 'chatId');
      const entryId = requireStringField(body, 'entryId');
      const content = requireContentField(body, 'content');
      const expectedRevision = body.expectedRevision;
      if (typeof expectedRevision !== 'number' || !Number.isInteger(expectedRevision) || expectedRevision < 1) {
        throw new ValidationDomainError('expectedRevision must be a positive integer');
      }
      const result = await commands.submitQueueEntryReplace({
        clientRequestId,
        chatId,
        entryId,
        content,
        expectedRevision,
      });
      return Response.json(result);
    } catch (error: unknown) {
      if (error instanceof CommandValidationError) {
        return jsonError(error.message, error.status, error.code, error.retryable);
      }
      if (error instanceof QueueEntryMutationError) return queueEntryErrorResponse(error);
      return jsonErrorFromUnknown(error);
    }
  }

  async function deleteQueueEntry(
    body: Partial<QueueEntryDeleteCommandRequest> & Record<string, unknown>,
  ): Promise<Response> {
    try {
      const clientRequestId = requireStringField(body, 'clientRequestId');
      const chatId = requireStringField(body, 'chatId');
      const entryId = requireStringField(body, 'entryId');
      const result = await commands.submitQueueEntryDelete({
        clientRequestId,
        chatId,
        entryId,
      });
      return Response.json(result);
    } catch (error: unknown) {
      if (error instanceof CommandValidationError) {
        return jsonError(error.message, error.status, error.code, error.retryable);
      }
      if (error instanceof QueueEntryMutationError) return queueEntryErrorResponse(error);
      return jsonErrorFromUnknown(error);
    }
  }

  async function postActiveInput(
    body: Partial<ActiveInputCommandRequest> & Record<string, unknown>,
  ): Promise<Response> {
    try {
      const clientRequestId = requireStringField(body, 'clientRequestId');
      const chatId = requireStringField(body, 'chatId');
      const content = requireContentField(body, 'content');
      const result = await commands.submitActiveInput({
        clientRequestId,
        chatId,
        content,
      });
      return Response.json(result, { status: 202 });
    } catch (error: unknown) {
      if (error instanceof CommandValidationError) {
        return jsonError(error.message, error.status, error.code, error.retryable);
      }
      if (error instanceof ActiveInputDeliveryError) {
        logger.error('queue: active input delivery failed:', error.cause);
      }
      return jsonErrorFromUnknown(error);
    }
  }

  async function postQueueMutation(
    body: (QueueMutationRequest | QueueResumeRequest) & Record<string, unknown>,
    action: 'clear' | 'pause' | 'resume',
  ): Promise<Response> {
    try {
      const chatId = requireStringField(body, 'chatId');
      const pauseId = action === 'resume' ? requireStringField(body, 'pauseId') : undefined;
      const result = await commands.mutateQueue({ chatId, action, pauseId });
      return Response.json(result);
    } catch (error: unknown) {
      if (error instanceof CommandValidationError) {
        return jsonError(error.message, error.status, error.code, error.retryable);
      }
      if (error instanceof QueuePauseChangedError) return queueEntryErrorResponse(error);
      return jsonErrorFromUnknown(error);
    }
  }

  async function postPermissionDecision(
    body: Partial<PermissionDecisionCommandRequest> & Record<string, unknown>,
  ): Promise<Response> {
    try {
      const clientRequestId = requireStringField(body, 'clientRequestId');
      const chatId = requireStringField(body, 'chatId');
      const permissionRequestId = requireStringField(body, 'permissionRequestId');
      const result = await commands.submitPermissionDecision({
        chatId,
        permissionRequestId,
        allow: Boolean(body.allow),
        alwaysAllow: Boolean(body.alwaysAllow),
        response: optionalRecord(body.response),
        clientRequestId,
      });
      return Response.json(result);
    } catch (error: unknown) {
      if (error instanceof CommandValidationError) {
        return jsonError(error.message, error.status, error.code, error.retryable);
      }
      return jsonErrorFromUnknown(error);
    }
  }

  async function postStopChat(body: Partial<AgentStopCommandRequest> & Record<string, unknown>): Promise<Response> {
    try {
      const clientRequestId = requireStringField(body, 'clientRequestId');
      const chatId = requireStringField(body, 'chatId');
      const result = await commands.submitStop({
        chatId,
        clientRequestId,
        agentId: body.agentId,
      });
      return Response.json(result);
    } catch (error: unknown) {
      if (error instanceof CommandValidationError) {
        return jsonError(error.message, error.status, error.code, error.retryable);
      }
      return jsonErrorFromUnknown(error);
    }
  }

  async function postInterruptAndSend(
    body: Partial<AgentInterruptAndSendCommandRequest> & Record<string, unknown>,
  ): Promise<Response> {
    try {
      const clientRequestId = requireStringField(body, 'clientRequestId');
      const chatId = requireStringField(body, 'chatId');
      const result = await commands.submitInterruptAndSend({
        chatId,
        clientRequestId,
        agentId: body.agentId,
      });
      return Response.json(result);
    } catch (error: unknown) {
      if (error instanceof CommandValidationError) {
        return jsonError(error.message, error.status, error.code, error.retryable);
      }
      return jsonErrorFromUnknown(error);
    }
  }

  async function postCompactChat(body: Partial<CompactCommandRequest> & Record<string, unknown>): Promise<Response> {
    try {
      const clientRequestId = requireStringField(body, 'clientRequestId');
      const chatId = requireStringField(body, 'chatId');
      const result = await commands.submitCompact({
        chatId,
        clientRequestId,
        instructions: typeof body.instructions === 'string' ? body.instructions : undefined,
      });
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
        patch.thinkingMode = normalizeThinkingModeForAgent(chat.agentId, body.thinkingMode);
      }
      if (body.claudeThinkingMode !== undefined) {
        patch.claudeThinkingMode = normalizeClaudeThinkingMode(body.claudeThinkingMode);
      }
      if (body.ampAgentMode !== undefined) {
        patch.ampAgentMode = normalizeAmpAgentMode(body.ampAgentMode);
      }
      if (Object.keys(patch).length > 0) await agents.updateSessionSettings(chatId, patch);
      return Response.json({ success: true, chatId, ...patch });
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
      return Response.json({ success: true, chatId, ...patch });
    } catch (error: unknown) {
      return chatSettingsPatchErrorResponse(error);
    }
  }

  // Switches a chat's agent (or model within the same agent). Cross-agent
  // switches start a fresh native session seeded from the prior transcript.
  async function patchAgentModel(body: AgentModelPatchRequest & Record<string, unknown>): Promise<Response> {
    try {
      const chatId = requireStringField(body, 'chatId');
      const agentId = requireStringField(body, 'agentId');
      const model = requireStringField(body, 'model');
      if (!agents.hasAgent(agentId)) return jsonError(`Unsupported agent: ${agentId}`, 422, 'UNSUPPORTED_AGENT');
      const existingChat = registry.getChat(chatId);
      if (!existingChat) return jsonError('Session not found', 404, 'SESSION_NOT_FOUND');
      // Same-agent model changes are owned by /api/v1/chats/model; this endpoint
      // only performs cross-agent switches that stage a fresh native session.
      if (agentId === existingChat.agentId) {
        return jsonError('Use /api/v1/chats/model to change model for the same agent.', 422, 'SAME_AGENT');
      }
      const updated = await agentSwitch.switchAgentModel({
        chatId,
        agentId,
        model,
        apiProviderId: optionalStringOrNull(body.apiProviderId),
        modelEndpointId: optionalStringOrNull(body.modelEndpointId),
        modelProtocol: optionalStringOrNull(body.modelProtocol) as AgentModelPatchRequest['modelProtocol'],
      });
      return Response.json({
        success: true,
        chatId,
        agentId: updated.agentId,
        model: updated.model,
        apiProviderId: updated.apiProviderId ?? null,
        modelEndpointId: updated.modelEndpointId ?? null,
        modelProtocol: updated.modelProtocol ?? null,
        permissionMode: updated.permissionMode,
        thinkingMode: updated.thinkingMode,
        claudeThinkingMode: updated.claudeThinkingMode,
        ampAgentMode: updated.ampAgentMode,
      });
    } catch (error: unknown) {
      return chatSettingsPatchErrorResponse(error);
    }
  }

  async function patchProjectPath(body: ProjectPathPatchRequest & Record<string, unknown>): Promise<Response> {
    try {
      const chatId = typeof body.chatId === 'string' ? body.chatId.trim() : '';
      const projectPath = typeof body.projectPath === 'string' ? body.projectPath.trim() : '';
      if (!chatId) return jsonError('chatId is required', 400, 'VALIDATION_FAILED');
      if (!projectPath) return jsonError('projectPath is required', 400, 'VALIDATION_FAILED');
      const result = await commands.updateProjectPath({ chatId, projectPath });
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
    '/api/v1/chats/compact': { POST: withJsonBody(postCompactChat) },
    '/api/v1/chats/messages': { GET: getMessages },
    '/api/v1/chats/search': { POST: withJsonBody(postSearchChats) },
    '/api/v1/chats/running': { GET: getRunningChats },
    '/api/v1/chats/queue': { GET: getQueue },
    '/api/v1/chats/queue/entries': {
      POST: withJsonBody(postQueueEntryCreate),
      PUT: withJsonBody(putQueueEntry),
      DELETE: withJsonBody(deleteQueueEntry),
    },
    '/api/v1/chats/active-input': { POST: withJsonBody(postActiveInput) },
    '/api/v1/chats/queue/clear': {
      POST: withJsonBody((body: QueueMutationRequest & Record<string, unknown>) => postQueueMutation(body, 'clear')),
    },
    '/api/v1/chats/queue/pause': {
      POST: withJsonBody((body: QueuePauseRequest & Record<string, unknown>) => postQueueMutation(body, 'pause')),
    },
    '/api/v1/chats/queue/resume': {
      POST: withJsonBody((body: QueueResumeRequest & Record<string, unknown>) => postQueueMutation(body, 'resume')),
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
    '/api/v1/chats/agent-model': { PATCH: withJsonBody(patchAgentModel) },
    '/api/v1/chats/project-path': { PATCH: withJsonBody(patchProjectPath) },
    '/api/v1/chats/details': { GET: getChatDetails },
    '/api/v1/chats/pin': { POST: withJsonBody(postTogglePin) },
    '/api/v1/chats/archive': { POST: withJsonBody(postToggleArchive) },
    '/api/v1/chats/read': { POST: withJsonBody(postMarkRead) },
    '/api/v1/chats/reorder': { POST: withJsonBody(postReorderChats) },
    '/api/v1/chats/reorder-quick': { POST: withJsonBody(postReorderQuick) },
    '/api/v1/chats/tags': { PATCH: withJsonBody(patchChatTags) },
  };
}
