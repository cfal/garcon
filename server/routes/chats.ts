// /api/chats/* route handlers. Provides CRUD for the session registry
// and dispatches message reads to the appropriate agent parser.

import { promises as fs } from 'fs';
import { withJsonBody } from '../lib/json-route.js';
import type { IChatRegistry } from '../chats/store.js';
import {
  normalizeAmpAgentMode,
  normalizeClaudeThinkingMode,
  normalizePermissionMode,
  normalizeThinkingMode,
} from '../../common/chat-modes.js';
import { ModelSelectionError } from "../api-providers/endpoint-resolver.js";
import type { AgentSessionSettingsPatch, RunAgentTurnOptions } from "../agents/session-types.js";
import { CommandValidationError, runOptionsFromCommandRequest } from '../commands/chat-command-service.js';
import type { ChatCommandService } from '../commands/chat-command-service.js';
import { normalizeQueueState, toClientQueueState } from '../../common/queue-state.ts';
import { normalizeTags } from '../../common/tags.ts';
import type {
  ChatListEntry,
  ChatListResponse,
  SetLastSelectedChatRequest,
  SetLastSelectedChatResponse,
} from '../../common/chat-list.js';
import { CHAT_MESSAGES_MAX_LIMIT, parsePagination } from '../lib/pagination.js';
import { assertRealWithinProjectBase, isProjectBoundaryError } from '../lib/path-boundary.js';
import { extractFirstLine } from '../lib/text.js';
import { jsonError, jsonErrorFromUnknown } from '../lib/http-error.js';
import { getAuthenticatedUsername } from '../lib/http-request.js';
import type { RouteMap } from '../lib/http-route-types.js';
import {
  InMemoryLastSelectedChatState,
  type LastSelectedChatState,
} from '../chats/last-selected-chat-state.js';
import type { ChatQueueService } from '../queue.js';
import type { ChatViewPageReader } from '../chats/chat-message-reader.js';
import type { ChatMetadata } from '../chats/metadata-store.js';
import type { PendingUserInputServiceContract } from '../chats/pending-user-input-service.js';
import type { AgentRegistryServiceContract } from '../agents/registry.js';
import { createLogger } from '../lib/log.js';

const logger = createLogger('routes:chats');
import type {
  AgentRunCommandRequest,
  AgentStopCommandRequest,
  CompactCommandRequest,
  ExecutionSettingsPatchRequest,
  ForkRunCommandRequest,
  ModelPatchRequest,
  PermissionDecisionCommandRequest,
  ProjectPathPatchRequest,
  QueueEnqueueCommandRequest,
  QueueMutationRequest,
  StartChatCommandRequest,
} from '../../common/chat-command-contracts.ts';

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
  reorderWindow(list: string, oldOrder: string[], newOrder: string[]): Promise<{ success: boolean; error?: string }>;
  reorderRelative(chatId: string, refId: string, mode: string): Promise<{ success: boolean; error?: string }>;
}

interface PathCacheDep {
  isProjectPathAvailable(projectPath: string): Promise<boolean>;
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

async function isGitRepository(projectPath: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(['git', 'rev-parse', '--is-inside-work-tree'], {
      cwd: projectPath,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return exitCode === 0 && stdout.trim() === 'true';
  } catch {
    return false;
  }
}

function createdAtFromId(id: string): string | null {
  const raw = String(id || '').trim();
  if (!/^\d+$/.test(raw)) return null;
  const msString = raw.length > 13 ? raw.slice(0, -3) : raw;
  const ts = parseInt(msString, 10);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  return new Date(ts).toISOString();
}

function requireStringField(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}

function bodyRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === 'object' ? body as Record<string, unknown> : {};
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function chatIdFromBodyOrQuery(body: unknown, url: URL): string {
  const input = bodyRecord(body);
  const bodyChatId = typeof input.chatId === 'string' ? input.chatId.trim() : '';
  if (bodyChatId) return bodyChatId;
  return url.searchParams.get('chatId')?.trim() || '';
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
  if (error instanceof Error && error.message.endsWith(' is required')) {
    return jsonError(error.message, 400, 'VALIDATION_FAILED');
  }
  return jsonErrorFromUnknown(error);
}

function pathValidationError(error: string, errorCode: string, status = 200): Response {
  return Response.json({
    success: false,
    valid: false,
    error,
    errorCode,
    retryable: false,
  }, { status });
}

function stringArrayOrNull(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null;
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
  commandService: ChatCommandService;
  lastSelectedChat?: LastSelectedChatState;
}

function currentOwnerUsername(request?: Request): string | null {
  return request ? getAuthenticatedUsername(request) : null;
}

function canAccessChat(
  session: { ownerUsername?: string | null } | null | undefined,
  ownerUsername: string | null,
): boolean {
  if (!session) return false;
  if (!ownerUsername) return true;
  return !session.ownerUsername || session.ownerUsername === ownerUsername;
}

function chatNotFound(): Response {
  return jsonError('Session not found', 404, 'SESSION_NOT_FOUND');
}

function getOwnedChat(
  registry: IChatRegistry,
  chatId: string,
  ownerUsername: string | null,
): ReturnType<IChatRegistry['getChat']> {
  const session = registry.getChat(chatId);
  return canAccessChat(session, ownerUsername) ? session : null;
}

function hasOwnedChat(registry: IChatRegistry, chatId: string, ownerUsername: string | null): boolean {
  return Boolean(getOwnedChat(registry, chatId, ownerUsername));
}

function allChatIdsOwned(
  registry: IChatRegistry,
  chatIds: string[],
  ownerUsername: string | null,
): boolean {
  if (!ownerUsername) return true;
  return chatIds.every((chatId) => hasOwnedChat(registry, chatId, ownerUsername));
}

function filterRunningSessionsByOwner(
  sessions: Record<string, Array<{ id: string; [key: string]: unknown }>>,
  registry: IChatRegistry,
  ownerUsername: string | null,
): Record<string, Array<{ id: string; [key: string]: unknown }>> {
  return Object.fromEntries(
    Object.entries(sessions).map(([agentId, entries]) => [
      agentId,
      entries.filter((entry) => hasOwnedChat(registry, entry.id, ownerUsername)),
    ]),
  );
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
  commandService,
  lastSelectedChat = new InMemoryLastSelectedChatState(),
}: ChatRouteDeps): RouteMap {
  const commands = commandService;

  function validatedLastSelectedChatId(
    rememberedChatId: string | null,
    allSessions: Record<string, unknown>,
    visibleEntries: Map<string, ChatListEntry>,
    ownerUsername: string | null,
  ): string | null {
    if (!rememberedChatId) return null;
    if (!(rememberedChatId in allSessions)) {
      lastSelectedChat.clearIf(rememberedChatId, ownerUsername);
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

  async function getChats(request: Request): Promise<Response> {
    try {
      const ownerUsername = currentOwnerUsername(request);
      const sessions = registry.listAllChats();
      const visibleSessions = Object.fromEntries(
        Object.entries(sessions).filter(([, session]) => canAccessChat(session, ownerUsername)),
      );
      const metadataMap = metadata.listAllChatMetadata();

      const pinnedList = settings.getPinnedChatIds();
      const normalList = settings.getNormalChatIds();
      const archivedList = settings.getArchivedChatIds();

      const pinnedIds = new Set(pinnedList);
      const archivedIds = new Set(archivedList);

      const availableSessions = await Promise.all(
        Object.entries(visibleSessions).map(async ([chatId, session]) => ({
          chatId,
          session,
          isAvailable: await pathCache.isProjectPathAvailable(session.projectPath),
        })),
      );

      const entryMap = new Map<string, ChatListEntry>();
      for (const { chatId, session, isAvailable } of availableSessions) {
        if (!isAvailable) continue;
        const meta = metadataMap.get(chatId) || null;
        const inferredCreatedAt = createdAtFromId(chatId);
        const overrideTitle = settings.getChatName(chatId);
        const isPinned = pinnedIds.has(chatId);
        const isArchived = !isPinned && archivedIds.has(chatId);
        const lastReadAt = session.lastReadAt ?? null;
        const lastActivityAt = meta?.lastActivity ?? null;
        const isUnread = Boolean(lastActivityAt && (!lastReadAt || lastActivityAt > lastReadAt));
        const title = extractFirstLine(overrideTitle || meta?.firstMessage || 'New Session');
        const firstPreview = extractFirstLine(meta?.firstMessage || title);
        const lastPreview = extractFirstLine(meta?.lastMessage || meta?.firstMessage || title);

        entryMap.set(chatId, {
          id: chatId,
          agentId: session.agentId,
          model: session.model || null,
          apiProviderId: session.apiProviderId ?? null,
          modelEndpointId: session.modelEndpointId ?? null,
          modelProtocol: session.modelProtocol ?? null,
          permissionMode: normalizePermissionMode(session.permissionMode),
          thinkingMode: normalizeThinkingMode(session.thinkingMode),
          claudeThinkingMode: normalizeClaudeThinkingMode(session.claudeThinkingMode),
          ampAgentMode: normalizeAmpAgentMode(session.ampAgentMode),
          title,
          projectPath: session.projectPath,
          tags: session.tags || [],
          activity: { createdAt: meta?.createdAt || inferredCreatedAt, lastActivityAt, lastReadAt },
          preview: {
            lastMessage: lastPreview,
            firstMessage: firstPreview,
          },
          isActive: agents.isAgentSessionRunning(session.agentId, session.agentSessionId),
          isPinned,
          isArchived,
          isUnread,
        });
      }

      const orderedFromList = (list: string[]): ChatListEntry[] =>
        list.map((id: string) => entryMap.get(id)).filter((entry): entry is ChatListEntry => Boolean(entry));

      const pinned = orderedFromList(pinnedList);
      const normal = orderedFromList(normalList);
      const archived = orderedFromList(archivedList);

      const listed = new Set([...pinnedList, ...normalList, ...archivedList]);
      const orphans: ChatListEntry[] = [];
      for (const [id, entry] of entryMap) {
        if (!listed.has(id)) orphans.push(entry);
      }
      if (orphans.length > 0) {
        orphans.sort((a, b) => (b.activity.createdAt || '').localeCompare(a.activity.createdAt || ''));
      }

      const all = [...pinned, ...orphans, ...normal, ...archived];
      const lastSelectedChatId = validatedLastSelectedChatId(
        lastSelectedChat.getLastSelectedChatId(ownerUsername),
        visibleSessions,
        entryMap,
        ownerUsername,
      );
      const body: ChatListResponse = { sessions: all, total: all.length, lastSelectedChatId };
      return Response.json(body);
    } catch (error: unknown) {
      logger.error('sessions: error listing sessions:', (error as Error).message);
      return jsonErrorFromUnknown(error);
    }
  }

  async function postStartSession(
    body: Partial<StartChatCommandRequest> & Record<string, unknown>,
    request: Request,
  ): Promise<Response> {
    try {
      const requestOptions = body.options && typeof body.options === 'object' ? body.options : {};
      const initialImages = Array.isArray((requestOptions as Record<string, unknown>).images) ? (requestOptions as Record<string, unknown>).images as unknown[] : [];
      const result = await commands.submitStart({
        chatId: String(body.chatId || ''),
        agentId: typeof body.agentId === 'string' ? body.agentId : '',
        projectPath: String(body.projectPath || ''),
        command: String(body.command || ''),
        model: typeof body.model === 'string' ? body.model : '',
        apiProviderId: typeof body.apiProviderId === 'string' ? body.apiProviderId : null,
        modelEndpointId: typeof body.modelEndpointId === 'string' ? body.modelEndpointId : null,
        modelProtocol: typeof body.modelProtocol === 'string' ? body.modelProtocol as StartChatCommandRequest['modelProtocol'] : null,
        permissionMode: body.permissionMode,
        thinkingMode: body.thinkingMode,
        claudeThinkingMode: body.claudeThinkingMode,
        ampAgentMode: body.ampAgentMode,
        tags: Array.isArray(body.tags) ? body.tags : undefined,
        requestOptions: requestOptions as Record<string, unknown>,
        images: initialImages as RunAgentTurnOptions['images'],
        clientRequestId: typeof body.clientRequestId === 'string' ? body.clientRequestId : undefined,
        clientMessageId: typeof body.clientMessageId === 'string' ? body.clientMessageId : undefined,
        ownerUsername: currentOwnerUsername(request),
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

  async function deleteSessionHandler(body: unknown, request: Request, url: URL): Promise<Response> {
    const chatId = chatIdFromBodyOrQuery(body, url);
    if (!chatId) return jsonError('chatId is required', 400);

    try {
      const ownerUsername = currentOwnerUsername(request);
      const session = getOwnedChat(registry, chatId, ownerUsername);
      if (!session) {
        return chatNotFound();
      }

      try {
        await queue.abort(chatId);
      } catch (error) {
        logger.warn(
          `sessions: abort before deleting ${chatId} failed:`,
          error instanceof Error ? error.message : String(error),
        );
      }

      // Removes registry state after abort because abortSession resolves the
      // owning agent through the chat entry.
      registry.removeChat(chatId);
      lastSelectedChat.clearIf(chatId, ownerUsername);

      await Promise.all([
        queue.deleteChatQueueFile(chatId).catch(() => {
          // Queue file may not exist.
        }),
        settings.removeFromAllOrderLists(chatId).catch(() => {}),
        settings.removeSessionName(chatId).catch(() => {}),
      ]);

      return Response.json({ success: true });
    } catch (error: unknown) {
      return jsonErrorFromUnknown(error);
    }
  }

  async function putLastSelectedChat(body: SetLastSelectedChatRequest | unknown, request: Request): Promise<Response> {
    const ownerUsername = currentOwnerUsername(request);
    const input = bodyRecord(body);
    const rawChatId = input.chatId;
    if (rawChatId === null) {
      lastSelectedChat.setLastSelectedChatId(null, ownerUsername);
      return Response.json({ success: true, lastSelectedChatId: null } satisfies SetLastSelectedChatResponse);
    }

    const chatId = typeof rawChatId === 'string' ? rawChatId.trim() : '';
    if (!chatId) {
      return jsonError('chatId is required', 400, 'VALIDATION_FAILED');
    }
    if (!hasOwnedChat(registry, chatId, ownerUsername)) {
      return chatNotFound();
    }

    lastSelectedChat.setLastSelectedChatId(chatId, ownerUsername);
    return Response.json({ success: true, lastSelectedChatId: chatId } satisfies SetLastSelectedChatResponse);
  }

  async function getMessages(request: Request, url: URL): Promise<Response> {
    const chatId = url.searchParams.get('chatId');
    if (!chatId) return jsonError('chatId query parameter is required', 400);

    try {
      const session = getOwnedChat(registry, chatId, currentOwnerUsername(request));
      if (!session) {
        return chatNotFound();
      }

      const { limit } = parsePagination(url.searchParams.get('limit'), null, { maxLimit: CHAT_MESSAGES_MAX_LIMIT });
      const beforeSeqRaw = url.searchParams.get('beforeSeq');
      const beforeSeq = beforeSeqRaw ? Number(beforeSeqRaw) : undefined;

      await pendingInputs.reconcile(chatId);
      const page = await chatViews.getOrCreatePage(chatId, limit, beforeSeq);
      return Response.json({
        chatId,
        generationId: page.generationId,
        messages: page.messages,
        lastSeq: page.lastSeq,
        pageOldestSeq: page.pageOldestSeq,
        hasMore: page.hasMore,
        limit,
        pendingUserInputs: pendingInputs.listForChat(chatId),
      });
    } catch (error: unknown) {
      logger.error(`sessions: error reading messages for ${chatId}:`, (error as Error).message);
      return jsonErrorFromUnknown(error);
    }
  }

  async function getChatDetails(request: Request, url: URL): Promise<Response> {
    const chatId = url.searchParams.get('chatId');
    if (!chatId) return jsonError('chatId query parameter is required', 400);

    try {
      const session = getOwnedChat(registry, chatId, currentOwnerUsername(request));
      if (!session) {
        return chatNotFound();
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

  async function postTogglePin(body: unknown, request: Request, url: URL): Promise<Response> {
    const chatId = chatIdFromBodyOrQuery(body, url);
    if (!chatId) return jsonError('chatId is required', 400);

    try {
      const session = getOwnedChat(registry, chatId, currentOwnerUsername(request));
      if (!session) {
        return chatNotFound();
      }

      const result = await settings.togglePin(chatId);
      return Response.json({ success: true, isPinned: result.isPinned });
    } catch (error: unknown) {
      return jsonErrorFromUnknown(error);
    }
  }

  async function postToggleArchive(body: unknown, request: Request, url: URL): Promise<Response> {
    const chatId = chatIdFromBodyOrQuery(body, url);
    if (!chatId) return jsonError('chatId is required', 400);

    try {
      const session = getOwnedChat(registry, chatId, currentOwnerUsername(request));
      if (!session) {
        return chatNotFound();
      }

      const result = await settings.toggleArchive(chatId);
      return Response.json({ success: true, isArchived: result.isArchived });
    } catch (error: unknown) {
      return jsonErrorFromUnknown(error);
    }
  }

  async function postMarkRead(body: Record<string, unknown>, request: Request): Promise<Response> {
    try {
      const ownerUsername = currentOwnerUsername(request);
      const entries = Array.isArray(body.entries) ? body.entries : [];
      if (entries.length === 0) {
        return Response.json({ success: true, results: [] });
      }

      const now = new Date().toISOString();
      const results: Array<{ chatId: string; lastReadAt: string }> = [];
      for (const entry of entries) {
        const chatId = String(entry.chatId || '').trim();
        if (!chatId) continue;

        const session = getOwnedChat(registry, chatId, ownerUsername);
        if (!session) continue;

        const incoming = entry.lastReadAt || now;
        const existing = session.lastReadAt || null;
        const merged = existing && existing > incoming ? existing : incoming;

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

  async function postReorderChats(body: Record<string, unknown>, request: Request): Promise<Response> {
    try {
      const ownerUsername = currentOwnerUsername(request);
      const list = typeof body?.list === 'string' ? body.list : '';
      const oldOrder = stringArrayOrNull(body?.oldOrder);
      const newOrder = stringArrayOrNull(body?.newOrder);

      if (!['pinned', 'normal', 'archived'].includes(list)) {
        return jsonError('list must be "pinned", "normal", or "archived"', 400);
      }
      if (!oldOrder || !newOrder) {
        return jsonError('oldOrder and newOrder must be arrays', 400);
      }
      if (!allChatIdsOwned(registry, [...oldOrder, ...newOrder], ownerUsername)) {
        return chatNotFound();
      }

      const result = await settings.reorderWindow(list, oldOrder, newOrder);
      if (!result.success) {
        return jsonError(result.error || 'Unable to reorder chats', 400);
      }

      return Response.json({ success: true });
    } catch (error: unknown) {
      return jsonErrorFromUnknown(error);
    }
  }

  async function postReorderQuick(body: Record<string, unknown>, request: Request): Promise<Response> {
    try {
      const ownerUsername = currentOwnerUsername(request);
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

      const session = getOwnedChat(registry, chatId, ownerUsername);
      if (!session) return jsonError('Chat not found', 404, 'SESSION_NOT_FOUND');

      const refSession = getOwnedChat(registry, refId, ownerUsername);
      if (!refSession) return jsonError('Reference chat not found', 404, 'SESSION_NOT_FOUND');

      const result = await settings.reorderRelative(chatId, refId, mode);
      if (!result.success) {
        const status = result.error!.includes('not found') ? 404 : 400;
        return jsonError(result.error || 'Unable to reorder chats', status, status === 404 ? 'SESSION_NOT_FOUND' : 'VALIDATION_FAILED');
      }

      return Response.json({ success: true });
    } catch (error: unknown) {
      return jsonErrorFromUnknown(error);
    }
  }

  async function patchChatTags(body: Record<string, unknown>, request: Request): Promise<Response> {
    try {
      const chatId = String(body.chatId || '').trim();
      if (!chatId) {
        return jsonError('chatId is required', 400);
      }

      const session = getOwnedChat(registry, chatId, currentOwnerUsername(request));
      if (!session) {
        return chatNotFound();
      }

      const rawTags = Array.isArray(body.tags) ? body.tags : [];
      const tags = normalizeTags(rawTags);

      registry.updateChat(chatId, { tags });
      return Response.json({ success: true, chatId, tags });
    } catch (error: unknown) {
      return jsonErrorFromUnknown(error);
    }
  }

  async function postForkChat(body: Record<string, unknown>, request: Request): Promise<Response> {
    try {
      const sourceChatId = String(body.sourceChatId || '').trim();
      const chatId = String(body.chatId || '').trim();
      if (!sourceChatId || !/^\d+$/.test(sourceChatId)) {
        return jsonError('Valid numeric sourceChatId is required', 400, 'VALIDATION_FAILED');
      }
      if (!chatId || !/^\d+$/.test(chatId)) {
        return jsonError('Valid numeric chatId is required', 400, 'VALIDATION_FAILED');
      }
      if (sourceChatId === chatId) {
        return jsonError('sourceChatId and chatId must differ', 400, 'VALIDATION_FAILED');
      }
      if (!hasOwnedChat(registry, sourceChatId, currentOwnerUsername(request))) {
        return chatNotFound();
      }

      const result = await commands.forkChat({
        sourceChatId,
        chatId,
        ...(body.upToSeq == null ? {} : { upToSeq: body.upToSeq }),
      });

      return Response.json({ success: true, ...result });
    } catch (error: unknown) {
      if (error instanceof CommandValidationError) {
        return jsonError(error.message, error.status, error.code, error.retryable);
      }
      return jsonErrorFromUnknown(error);
    }
  }

  async function postRunChat(body: Partial<AgentRunCommandRequest> & Record<string, unknown>, request: Request): Promise<Response> {
    try {
      const clientRequestId = requireStringField(body, 'clientRequestId');
      const clientMessageId = requireStringField(body, 'clientMessageId');
      const chatId = requireStringField(body, 'chatId');
      const command = typeof body.command === 'string' ? body.command : '';
      const images = Array.isArray(body.images) ? body.images : undefined;
      if (!command.trim() && (!images || images.length === 0)) {
        return jsonError('command or images are required', 400);
      }
      const session = getOwnedChat(registry, chatId, currentOwnerUsername(request));
      if (!session) return jsonError('Session not found', 404, 'SESSION_NOT_FOUND');

      const payload = {
        chatId,
        clientMessageId,
        command,
        images,
        permissionMode: body.permissionMode,
        thinkingMode: body.thinkingMode,
        claudeThinkingMode: body.claudeThinkingMode,
        ampAgentMode: body.ampAgentMode,
        model: body.model,
        apiProviderId: body.apiProviderId,
        modelEndpointId: body.modelEndpointId,
        modelProtocol: body.modelProtocol,
      };

      const options = runOptionsFromCommandRequest(body as AgentRunCommandRequest);
      const result = await commands.submitRun({
        chatId,
        command,
        images,
        clientRequestId,
        clientMessageId,
        options,
        payload,
      });

      return Response.json(result, { status: 202 });
    } catch (error: unknown) {
      if (error instanceof CommandValidationError) {
        return jsonError(error.message, error.status, error.code, error.retryable);
      }
      return jsonError((error as Error).message, 500, 'INTERNAL_ERROR', true);
    }
  }

  async function postForkRunChat(
    body: Partial<ForkRunCommandRequest> & Record<string, unknown>,
    request: Request,
  ): Promise<Response> {
    try {
      const clientRequestId = requireStringField(body, 'clientRequestId');
      const clientMessageId = requireStringField(body, 'clientMessageId');
      const sourceChatId = requireStringField(body, 'sourceChatId');
      const chatId = requireStringField(body, 'chatId');
      const command = requireStringField(body, 'command');
      if (!hasOwnedChat(registry, sourceChatId, currentOwnerUsername(request))) {
        return chatNotFound();
      }

      const payload = {
        sourceChatId,
        chatId,
        clientMessageId,
        command,
        images: Array.isArray(body.images) ? body.images : undefined,
        permissionMode: body.permissionMode,
        thinkingMode: body.thinkingMode,
        claudeThinkingMode: body.claudeThinkingMode,
        ampAgentMode: body.ampAgentMode,
        model: body.model,
        apiProviderId: body.apiProviderId,
        modelEndpointId: body.modelEndpointId,
        modelProtocol: body.modelProtocol,
      };

      const options = runOptionsFromCommandRequest(body as ForkRunCommandRequest);
      const result = await commands.submitForkRun({
        sourceChatId,
        chatId,
        command,
        images: Array.isArray(body.images) ? body.images : undefined,
        clientRequestId,
        clientMessageId,
        options,
        payload,
      });

      return Response.json({
        ...result,
        sourceChatId,
      }, { status: 202 });
    } catch (error: unknown) {
      if (error instanceof CommandValidationError) {
        return jsonError(error.message, error.status, error.code, error.retryable);
      }
      return jsonError((error as Error).message, 500, 'INTERNAL_ERROR', true);
    }
  }

  async function getRunningChats(request: Request): Promise<Response> {
    return Response.json({
      sessions: filterRunningSessionsByOwner(
        agents.getRunningSessions(),
        registry,
        currentOwnerUsername(request),
      ),
    });
  }

  async function getQueue(_request: Request, url: URL): Promise<Response> {
    const chatId = url.searchParams.get('chatId');
    if (!chatId) return jsonError('chatId query parameter is required', 400);
    if (!hasOwnedChat(registry, chatId, currentOwnerUsername(_request))) return chatNotFound();
    const state = toClientQueueState(normalizeQueueState(await queue.readChatQueue(chatId)));
    return Response.json({ success: true, chatId, queue: state });
  }

  async function postQueueEnqueue(
    body: Partial<QueueEnqueueCommandRequest> & Record<string, unknown>,
    request: Request,
  ): Promise<Response> {
    try {
      const clientRequestId = requireStringField(body, 'clientRequestId');
      const chatId = requireStringField(body, 'chatId');
      const content = requireStringField(body, 'content');
      if (!hasOwnedChat(registry, chatId, currentOwnerUsername(request))) return chatNotFound();
      const result = await commands.submitQueueEnqueue({ chatId, content, clientRequestId });
      return Response.json(result, { status: 202 });
    } catch (error: unknown) {
      if (error instanceof CommandValidationError) {
        return jsonError(error.message, error.status, error.code, error.retryable);
      }
      return jsonError((error as Error).message, 500, 'INTERNAL_ERROR', true);
    }
  }

  async function postQueueMutation(
    body: QueueMutationRequest & Record<string, unknown>,
    action: 'dequeue' | 'clear' | 'pause' | 'resume',
    request: Request,
  ): Promise<Response> {
    try {
      const chatId = requireStringField(body, 'chatId');
      if (!hasOwnedChat(registry, chatId, currentOwnerUsername(request))) return chatNotFound();
      const result = await commands.mutateQueue({
        chatId,
        action,
        entryId: typeof body.entryId === 'string' ? body.entryId : undefined,
      });
      return Response.json(result);
    } catch (error: unknown) {
      if (error instanceof CommandValidationError) {
        return jsonError(error.message, error.status, error.code, error.retryable);
      }
      return jsonError((error as Error).message, 500, 'INTERNAL_ERROR', true);
    }
  }

  async function postPermissionDecision(
    body: Partial<PermissionDecisionCommandRequest> & Record<string, unknown>,
    request: Request,
  ): Promise<Response> {
    try {
      const clientRequestId = requireStringField(body, 'clientRequestId');
      const chatId = requireStringField(body, 'chatId');
      const permissionRequestId = requireStringField(body, 'permissionRequestId');
      if (!hasOwnedChat(registry, chatId, currentOwnerUsername(request))) return chatNotFound();
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
      return jsonError((error as Error).message, 500, 'INTERNAL_ERROR', true);
    }
  }

  async function postStopChat(body: Partial<AgentStopCommandRequest> & Record<string, unknown>, request: Request): Promise<Response> {
    try {
      const clientRequestId = requireStringField(body, 'clientRequestId');
      const chatId = requireStringField(body, 'chatId');
      if (!hasOwnedChat(registry, chatId, currentOwnerUsername(request))) return chatNotFound();
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
      return jsonError((error as Error).message, 500, 'INTERNAL_ERROR', true);
    }
  }

  async function postCompactChat(body: Partial<CompactCommandRequest> & Record<string, unknown>, request: Request): Promise<Response> {
    try {
      const clientRequestId = requireStringField(body, 'clientRequestId');
      const chatId = requireStringField(body, 'chatId');
      if (!hasOwnedChat(registry, chatId, currentOwnerUsername(request))) return chatNotFound();
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
      return jsonError((error as Error).message, 500, 'INTERNAL_ERROR', true);
    }
  }

  async function patchExecutionSettings(body: ExecutionSettingsPatchRequest & Record<string, unknown>, request: Request): Promise<Response> {
    try {
      const chatId = requireStringField(body, 'chatId');
      if (!hasOwnedChat(registry, chatId, currentOwnerUsername(request))) return chatNotFound();
      const patch: AgentSessionSettingsPatch = {};
      if (body.permissionMode !== undefined) {
        patch.permissionMode = normalizePermissionMode(body.permissionMode);
      }
      if (body.thinkingMode !== undefined) {
        patch.thinkingMode = normalizeThinkingMode(body.thinkingMode);
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

  async function patchModel(body: ModelPatchRequest & Record<string, unknown>, request: Request): Promise<Response> {
    try {
      const chatId = requireStringField(body, 'chatId');
      const model = requireStringField(body, 'model');
      if (!hasOwnedChat(registry, chatId, currentOwnerUsername(request))) return chatNotFound();
      const apiProviderId = optionalStringOrNull(body.apiProviderId);
      const modelEndpointId = optionalStringOrNull(body.modelEndpointId);
      const modelProtocol = optionalStringOrNull(body.modelProtocol);
      const patch: AgentSessionSettingsPatch = { model };
      if (apiProviderId !== undefined) patch.apiProviderId = apiProviderId;
      if (modelEndpointId !== undefined) patch.modelEndpointId = modelEndpointId;
      if (modelProtocol !== undefined) patch.modelProtocol = modelProtocol as AgentSessionSettingsPatch['modelProtocol'];
      await agents.updateSessionSettings(chatId, patch);
      return Response.json({ success: true, chatId, ...patch });
    } catch (error: unknown) {
      return chatSettingsPatchErrorResponse(error);
    }
  }

  async function patchProjectPath(body: ProjectPathPatchRequest & Record<string, unknown>, request: Request): Promise<Response> {
    try {
      const chatId = typeof body.chatId === 'string' ? body.chatId.trim() : '';
      const projectPath = typeof body.projectPath === 'string' ? body.projectPath.trim() : '';
      if (!chatId) return jsonError('chatId is required', 400, 'VALIDATION_FAILED');
      if (!projectPath) return jsonError('projectPath is required', 400, 'VALIDATION_FAILED');
      if (!hasOwnedChat(registry, chatId, currentOwnerUsername(request))) return chatNotFound();
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
    '/api/v1/chats': { GET: getChats, DELETE: withJsonBody(deleteSessionHandler) },
    '/api/v1/chats/last-selected': { PUT: withJsonBody(putLastSelectedChat) },
    '/api/v1/chats/start': { POST: withJsonBody(postStartSession) },
    '/api/v1/chats/run': { POST: withJsonBody(postRunChat) },
    '/api/v1/chats/validate-start': { GET: validateStartPath },
    '/api/v1/chats/fork': { POST: withJsonBody(postForkChat) },
    '/api/v1/chats/fork-run': { POST: withJsonBody(postForkRunChat) },
    '/api/v1/chats/compact': { POST: withJsonBody(postCompactChat) },
    '/api/v1/chats/messages': { GET: getMessages },
    '/api/v1/chats/running': { GET: getRunningChats },
    '/api/v1/chats/queue': { GET: getQueue },
    '/api/v1/chats/queue/enqueue': { POST: withJsonBody(postQueueEnqueue) },
    '/api/v1/chats/queue/dequeue': { POST: withJsonBody((body: QueueMutationRequest & Record<string, unknown>, request: Request) => postQueueMutation(body, 'dequeue', request)) },
    '/api/v1/chats/queue/clear': { POST: withJsonBody((body: QueueMutationRequest & Record<string, unknown>, request: Request) => postQueueMutation(body, 'clear', request)) },
    '/api/v1/chats/queue/pause': { POST: withJsonBody((body: QueueMutationRequest & Record<string, unknown>, request: Request) => postQueueMutation(body, 'pause', request)) },
    '/api/v1/chats/queue/resume': { POST: withJsonBody((body: QueueMutationRequest & Record<string, unknown>, request: Request) => postQueueMutation(body, 'resume', request)) },
    '/api/v1/chats/permissions/decision': { POST: withJsonBody(postPermissionDecision) },
    '/api/v1/chats/stop': { POST: withJsonBody(postStopChat) },
    '/api/v1/chats/execution-settings': { PATCH: withJsonBody(patchExecutionSettings) },
    '/api/v1/chats/model': { PATCH: withJsonBody(patchModel) },
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
