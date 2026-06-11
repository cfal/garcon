// /api/chats/* route handlers. Provides CRUD for the session registry
// and dispatches message reads to the appropriate agent parser.

import { promises as fs } from 'fs';
import { withJsonBody } from '../lib/json-route.js';
import type { IChatRegistry } from '../chats/store.js';
import { isArtificialNativePath } from '../chats/artificial-native-path.js';
import {
  normalizeAmpAgentMode,
  normalizeClaudeThinkingMode,
  normalizePermissionMode,
  normalizeThinkingMode,
} from '../../common/chat-modes.js';
import { forkChatFileCopy } from '../chats/fork-chat.js';
import { ModelSelectionError } from "../api-providers/endpoint-resolver.js";
import { CommandLedger } from '../commands/command-ledger.js';
import type { AgentSessionSettingsPatch, RunAgentTurnOptions } from "../agents/session-types.js";
import {
  ChatCommandService,
  CommandValidationError,
  runOptionsFromCommandRequest,
} from '../commands/chat-command-service.js';
import { normalizeQueueState } from '../../common/queue-state.ts';
import { normalizeTags } from '../../common/tags.ts';
import { CHAT_MESSAGES_MAX_LIMIT, parsePagination } from '../lib/pagination.js';
import { isWithinProjectBase } from '../lib/path-boundary.js';
import type {
  AgentRunCommandRequest,
  AgentStopCommandRequest,
  CommandErrorCode,
  ExecutionSettingsPatchRequest,
  ForkRunCommandRequest,
  ModelPatchRequest,
  PermissionDecisionCommandRequest,
  QueueEnqueueCommandRequest,
  QueueMutationRequest,
  StartChatCommandRequest,
} from '../../common/chat-command-contracts.ts';

type RouteHandler = (request: Request, url: URL) => Promise<Response> | Response;
type RouteMap = Record<string, Record<string, RouteHandler>>;

interface SettingsDep {
  getPinnedChatIds(): Promise<string[]>;
  getNormalChatIds(): Promise<string[]>;
  getArchivedChatIds(): Promise<string[]>;
  getChatName(chatId: string): string | null;
  setLastChatDefaults(defaults: Record<string, unknown>): Promise<void>;
  ensureInNormal(chatId: string): Promise<void>;
  removeFromAllOrderLists(chatId: string): Promise<void>;
  removeSessionName(chatId: string): Promise<void>;
  togglePin(chatId: string): Promise<{ isPinned: boolean }>;
  toggleArchive(chatId: string): Promise<{ isArchived: boolean }>;
  reorderWindow(list: string, oldOrder: string[], newOrder: string[]): Promise<{ success: boolean; error?: string }>;
  reorderRelative(chatId: string, refId: string, mode: string): Promise<{ success: boolean; error?: string }>;
}

interface QueueDep {
  deleteChatQueueFile(chatId: string): Promise<void>;
  submit(chatId: string, command: string, options: RunAgentTurnOptions): Promise<void>;
  registerPendingUserInput(chatId: string, command: string, options: RunAgentTurnOptions): Promise<void>;
  appendUserMessage?(chatId: string, command: string, options: RunAgentTurnOptions): Promise<void>;
  runAcceptedTurn(chatId: string, command: string, options: RunAgentTurnOptions): Promise<void>;
  abort(chatId: string): Promise<boolean>;
  triggerDrain(chatId: string): Promise<void>;
  readChatQueue(chatId: string): Promise<unknown>;
  enqueueChat(chatId: string, content: string): Promise<{ entry: { id: string }; queue: unknown }>;
  dequeueChat(chatId: string, entryId: string): Promise<unknown>;
  clearChatQueue(chatId: string): Promise<unknown>;
  pauseChatQueue(chatId: string): Promise<unknown>;
  resumeChatQueue(chatId: string): Promise<unknown>;
}

interface PathCacheDep {
  isProjectPathAvailable(projectPath: string): Promise<boolean>;
}

interface MetadataDep {
  listAllChatMetadata(): Map<string, Record<string, unknown>>;
  getChatMetadata(chatId: string): Record<string, unknown> | null;
  addNewChatMetadata(chatId: string, command: string): void;
}

interface HistoryCacheDep {
  ensureLoaded(chatId: string): Promise<void>;
  getPaginatedMessages(chatId: string, limit: number, offset: number): unknown;
  appendMessages(chatId: string, messages: unknown[]): Promise<void>;
}

interface AgentRegistryDep {
  hasAgent(agentId: string): boolean;
  supportsFork(agentId: string): boolean;
  supportsImages(agentId: string): boolean;
  isAgentSessionRunning(agentId: string, agentSessionId: string | null | undefined): boolean;
  getRunningSessions(): Record<string, Array<{ id: string; [key: string]: unknown }>>;
  startSession(chatId: string, command: string, opts: Record<string, unknown>): Promise<void>;
  forkAgentSession?(args: { sourceSession: unknown; sourceChatId: string; targetChatId: string }): Promise<{ agentSessionId: string; nativePath: string | null } | null>;
  modelSupportsImages(input: { agentId: string; model: string; apiProviderId?: string | null; modelEndpointId?: string | null }): Promise<boolean>;
  runSingleQuery(prompt: string, opts?: Record<string, unknown>): Promise<string>;
  resolvePermission(chatId: string, permissionRequestId: string, decision: { allow: boolean; alwaysAllow: boolean }): void;
  updateSessionSettings(chatId: string, patch: AgentSessionSettingsPatch): Promise<unknown>;
}

interface PendingInputsDep {
  register(chatId: string, content: string, options?: {
    clientRequestId?: string;
    clientMessageId?: string;
    turnId?: string;
    images?: RunAgentTurnOptions['images'];
    deliveryStatus?: 'submitting' | 'accepted' | 'failed';
  }): Promise<unknown>;
  reconcile(chatId: string): Promise<void>;
  listForChat(chatId: string): unknown[];
  clearChat(chatId: string, reason?: 'persisted' | 'chat-removed'): void;
}

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

function extractFirstLine(text: string | null | undefined): string {
  if (!text) return '';
  const nl = text.indexOf('\n');
  if (nl < 0) return text.trim();
  return text.slice(0, nl).trim();
}

function jsonError(error: string, status: number, errorCode: CommandErrorCode = 'VALIDATION_FAILED', retryable = false, details?: string): Response {
  return Response.json({ success: false, error, errorCode, retryable, details }, { status });
}

function requireStringField(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}

function optionalStringOrNull(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return typeof value === 'string' ? value : null;
}

interface ChatRouteDeps {
  registry: IChatRegistry;
  settings: SettingsDep;
  queue: QueueDep;
  pathCache: PathCacheDep;
  metadata: MetadataDep;
  historyCache: HistoryCacheDep;
  agents: AgentRegistryDep;
  commandLedger: CommandLedger;
  pendingInputs: PendingInputsDep;
  commandService?: ChatCommandService;
}

export default function createChatRoutes({
  registry,
  settings,
  queue,
  pathCache,
  metadata,
  historyCache,
  agents,
  commandLedger,
  pendingInputs,
  commandService,
}: ChatRouteDeps): RouteMap {
  const commands = commandService ?? new ChatCommandService({
    chats: registry,
    queue,
    ledger: commandLedger,
    settings,
    metadata,
    agents,
    pendingInputs,
  });

  async function validateStartPath(_request: Request, url: URL): Promise<Response> {
    const dirPath = String(url.searchParams.get('path') || '').trim();
    if (!dirPath) {
      return Response.json(
        { valid: false, error: 'path is required', errorCode: 'path_required' },
        { status: 400 },
      );
    }

    if (!isWithinProjectBase(dirPath)) {
      return Response.json({
        valid: false,
        error: 'Path is outside the allowed base directory',
        errorCode: 'outside_base_dir',
      });
    }

    try {
      const stat = await fs.stat(dirPath);
      if (!stat.isDirectory()) {
        return Response.json({ valid: false, error: 'Not a directory', errorCode: 'not_directory' });
      }
      const isGitRepo = await isGitRepository(dirPath);
      return Response.json({ valid: true, isGitRepo });
    } catch (error: unknown) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        return Response.json({ valid: false, error: 'Path does not exist', errorCode: 'path_not_found' });
      }
      if (err.code === 'EACCES' || err.code === 'EPERM') {
        return Response.json({ valid: false, error: 'Permission denied', errorCode: 'permission_denied' });
      }
      return Response.json({ valid: false, error: (error as Error).message, errorCode: 'unknown' });
    }
  }

  async function getChats(): Promise<Response> {
    try {
      const sessions = registry.listAllChats();
      const metadataMap = metadata.listAllChatMetadata();

      let pinnedList: string[], normalList: string[], archivedList: string[];
      try { pinnedList = await settings.getPinnedChatIds(); } catch { pinnedList = []; }
      try { normalList = await settings.getNormalChatIds(); } catch { normalList = []; }
      try { archivedList = await settings.getArchivedChatIds(); } catch { archivedList = []; }

      const pinnedIds = new Set(pinnedList);
      const archivedIds = new Set(archivedList);

      const availableSessions = await Promise.all(
        Object.entries(sessions).map(async ([chatId, session]) => ({
          chatId,
          session,
          isAvailable: await pathCache.isProjectPathAvailable(session.projectPath as string),
        })),
      );

      const entryMap = new Map<string, Record<string, unknown>>();
      for (const { chatId, session, isAvailable } of availableSessions) {
        if (!isAvailable) continue;
        const meta = metadataMap.get(chatId) || null;
        const inferredCreatedAt = createdAtFromId(chatId);
        const overrideTitle = settings.getChatName(chatId);
        const isPinned = pinnedIds.has(chatId);
        const isArchived = !isPinned && archivedIds.has(chatId);
        const lastReadAt = (session.lastReadAt as string) || null;
        const lastActivityAt = (meta?.lastActivity as string) || null;
        const isUnread = Boolean(lastActivityAt && (!lastReadAt || lastActivityAt > lastReadAt));
        const title = extractFirstLine((overrideTitle || meta?.firstMessage || 'New Session') as string);
        const firstPreview = extractFirstLine((meta?.firstMessage || title) as string);
        const lastPreview = extractFirstLine((meta?.lastMessage || meta?.firstMessage || title) as string);

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
          activity: { createdAt: (meta?.createdAt as string) || inferredCreatedAt, lastActivityAt, lastReadAt },
          preview: {
            lastMessage: lastPreview,
            firstMessage: firstPreview,
          },
          isActive: agents.isAgentSessionRunning(session.agentId as string, session.agentSessionId as string | null),
          isPinned,
          isArchived,
          isUnread,
        });
      }

      const orderedFromList = (list: string[]) => list.map((id: string) => entryMap.get(id)).filter(Boolean);

      const pinned = orderedFromList(pinnedList);
      const normal = orderedFromList(normalList);
      const archived = orderedFromList(archivedList);

      const listed = new Set([...pinnedList, ...normalList, ...archivedList]);
      const orphans: Record<string, unknown>[] = [];
      for (const [id, entry] of entryMap) {
        if (!listed.has(id)) orphans.push(entry);
      }
      if (orphans.length > 0) {
        orphans.sort((a, b) => ((b.activity as Record<string, string>).createdAt || '').localeCompare((a.activity as Record<string, string>).createdAt || ''));
      }

      const all = [...pinned, ...orphans, ...normal, ...archived];
      return Response.json({ sessions: all, total: all.length });
    } catch (error: unknown) {
      console.error('sessions: error listing sessions:', (error as Error).message);
      return Response.json({ success: false, error: (error as Error).message }, { status: 500 });
    }
  }

  async function postStartSession(body: Partial<StartChatCommandRequest> & Record<string, unknown>): Promise<Response> {
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
      });
      return Response.json(result, { status: 202 });
    } catch (error: unknown) {
      if (error instanceof CommandValidationError) {
        return jsonError(error.message, error.status, error.code, error.retryable);
      }
      if (error instanceof ModelSelectionError) {
        return Response.json({ success: false, error: (error as Error).message }, { status: 422 });
      }
      return Response.json({ success: false, error: (error as Error).message }, { status: 500 });
    }
  }

  async function deleteSessionHandler(_request: Request, url: URL): Promise<Response> {
    const chatId = url.searchParams.get('chatId');
    if (!chatId) return Response.json({ error: 'chatId query parameter is required' }, { status: 400 });

    try {
      const session = registry.getChat(chatId);
      if (!session) {
        return Response.json({ success: false, error: 'Session not found' }, { status: 404 });
      }

      // Remove from the in-memory registry first so the WS broadcast fires
      // immediately; disk cleanup then happens in parallel. Clients see the
      // chat disappear before the HTTP call resolves.
      registry.removeChat(chatId);

      const nativePath = session.nativePath && !isArtificialNativePath(session.nativePath)
        ? (session.nativePath as string)
        : null;

      await Promise.all([
        nativePath
          ? fs.unlink(nativePath).catch((error: NodeJS.ErrnoException) => {
              if (error.code !== 'ENOENT') {
                console.warn(`sessions: could not delete native file ${nativePath}:`, error.message);
              }
            })
          : Promise.resolve(),
        queue.deleteChatQueueFile(chatId).catch(() => {
          // Queue file may not exist.
        }),
        settings.removeFromAllOrderLists(chatId).catch(() => {}),
        settings.removeSessionName(chatId).catch(() => {}),
      ]);

      return Response.json({ success: true });
    } catch (error: unknown) {
      return Response.json({ success: false, error: (error as Error).message }, { status: 500 });
    }
  }

  async function getMessages(_request: Request, url: URL): Promise<Response> {
    const chatId = url.searchParams.get('chatId');
    if (!chatId) return Response.json({ error: 'chatId query parameter is required' }, { status: 400 });

    try {
      const session = registry.getChat(chatId);
      if (!session) {
        return Response.json({ success: false, error: 'Session not found' }, { status: 404 });
      }

      const { limit, offset } = parsePagination(url.searchParams.get('limit'), url.searchParams.get('offset'), { maxLimit: CHAT_MESSAGES_MAX_LIMIT });

      await historyCache.ensureLoaded(chatId);
      await pendingInputs.reconcile(chatId);
      const page = historyCache.getPaginatedMessages(chatId, limit, offset) as Record<string, unknown>;
      return Response.json({
        ...page,
        pendingUserInputs: pendingInputs.listForChat(chatId),
      });
    } catch (error: unknown) {
      console.error(`sessions: error reading messages for ${chatId}:`, (error as Error).message);
      return Response.json({ success: false, error: (error as Error).message }, { status: 500 });
    }
  }

  async function getChatDetails(_request: Request, url: URL): Promise<Response> {
    const chatId = url.searchParams.get('chatId');
    if (!chatId) return Response.json({ error: 'chatId query parameter is required' }, { status: 400 });

    try {
      const session = registry.getChat(chatId);
      if (!session) {
        return Response.json({ success: false, error: 'Session not found' }, { status: 404 });
      }

      const meta = metadata.getChatMetadata(chatId);
      return Response.json({
        chatId,
        firstMessage: meta?.firstMessage || '',
        createdAt: meta?.createdAt || null,
        lastActivityAt: meta?.lastActivity || null,
        nativePath: session.nativePath || null,
      });
    } catch (error: unknown) {
      return Response.json({ success: false, error: (error as Error).message }, { status: 500 });
    }
  }

  async function postTogglePin(_request: Request, url: URL): Promise<Response> {
    const chatId = url.searchParams.get('chatId');
    if (!chatId) return Response.json({ error: 'chatId query parameter is required' }, { status: 400 });

    try {
      const session = registry.getChat(chatId);
      if (!session) {
        return Response.json({ success: false, error: 'Session not found' }, { status: 404 });
      }

      const result = await settings.togglePin(chatId);
      return Response.json({ success: true, isPinned: result.isPinned });
    } catch (error: unknown) {
      return Response.json({ success: false, error: (error as Error).message }, { status: 500 });
    }
  }

  async function postToggleArchive(_request: Request, url: URL): Promise<Response> {
    const chatId = url.searchParams.get('chatId');
    if (!chatId) return Response.json({ error: 'chatId query parameter is required' }, { status: 400 });

    try {
      const session = registry.getChat(chatId);
      if (!session) {
        return Response.json({ success: false, error: 'Session not found' }, { status: 404 });
      }

      const result = await settings.toggleArchive(chatId);
      return Response.json({ success: true, isArchived: result.isArchived });
    } catch (error: unknown) {
      return Response.json({ success: false, error: (error as Error).message }, { status: 500 });
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

        const incoming = entry.lastReadAt || now;
        const existing = (session.lastReadAt as string) || null;
        const merged = existing && existing > incoming ? existing : incoming;

        registry.updateChat(chatId, { lastReadAt: merged });
        results.push({ chatId, lastReadAt: merged });
      }

      return Response.json({ success: true, results });
    } catch (error: unknown) {
      return Response.json({ success: false, error: (error as Error).message }, { status: 500 });
    }
  }

  async function postReorderChats(body: Record<string, unknown>): Promise<Response> {
    try {
      const list = body?.list;
      const oldOrder = Array.isArray(body?.oldOrder) ? body.oldOrder : null;
      const newOrder = Array.isArray(body?.newOrder) ? body.newOrder : null;

      if (!['pinned', 'normal', 'archived'].includes(list)) {
        return Response.json({ success: false, error: 'list must be "pinned", "normal", or "archived"' }, { status: 400 });
      }
      if (!oldOrder || !newOrder) {
        return Response.json({ success: false, error: 'oldOrder and newOrder must be arrays' }, { status: 400 });
      }

      const result = await settings.reorderWindow(list, oldOrder, newOrder);
      if (!result.success) {
        return Response.json({ success: false, error: result.error }, { status: 400 });
      }

      return Response.json({ success: true });
    } catch (error: unknown) {
      return Response.json({ success: false, error: (error as Error).message }, { status: 500 });
    }
  }

  async function postReorderQuick(body: Record<string, unknown>): Promise<Response> {
    try {
      const chatId = typeof body?.chatId === 'string' ? body.chatId.trim() : '';
      const chatIdAbove = typeof body?.chatIdAbove === 'string' ? body.chatIdAbove.trim() : '';
      const chatIdBelow = typeof body?.chatIdBelow === 'string' ? body.chatIdBelow.trim() : '';

      if (!chatId) {
        return Response.json({ success: false, error: 'chatId is required' }, { status: 400 });
      }
      if ((chatIdAbove && chatIdBelow) || (!chatIdAbove && !chatIdBelow)) {
        return Response.json({ success: false, error: 'Exactly one of chatIdAbove or chatIdBelow must be provided' }, { status: 400 });
      }

      const refId = chatIdAbove || chatIdBelow;
      const mode = chatIdAbove ? 'below' : 'above';

      const session = registry.getChat(chatId);
      if (!session) return Response.json({ success: false, error: 'Chat not found' }, { status: 404 });

      const refSession = registry.getChat(refId);
      if (!refSession) return Response.json({ success: false, error: 'Reference chat not found' }, { status: 404 });

      const result = await settings.reorderRelative(chatId, refId, mode);
      if (!result.success) {
        const status = result.error!.includes('not found') ? 404 : 400;
        return Response.json({ success: false, error: result.error }, { status });
      }

      return Response.json({ success: true });
    } catch (error: unknown) {
      return Response.json({ success: false, error: (error as Error).message }, { status: 500 });
    }
  }

  async function patchChatTags(body: Record<string, unknown>): Promise<Response> {
    try {
      const chatId = String(body.chatId || '').trim();
      if (!chatId) {
        return Response.json({ success: false, error: 'chatId is required' }, { status: 400 });
      }

      const session = registry.getChat(chatId);
      if (!session) {
        return Response.json({ success: false, error: 'Session not found' }, { status: 404 });
      }

      const rawTags = Array.isArray(body.tags) ? body.tags : [];
      const tags = normalizeTags(rawTags);

      registry.updateChat(chatId, { tags });
      return Response.json({ success: true, chatId, tags });
    } catch (error: unknown) {
      return Response.json({ success: false, error: (error as Error).message }, { status: 500 });
    }
  }

  async function postForkChat(body: Record<string, unknown>): Promise<Response> {
    try {
      const sourceChatId = String(body.sourceChatId || '').trim();
      const chatId = String(body.chatId || '').trim();

      if (!sourceChatId || !/^\d+$/.test(sourceChatId)) {
        return Response.json({ success: false, error: 'Valid numeric sourceChatId is required' }, { status: 400 });
      }
      if (!chatId || !/^\d+$/.test(chatId)) {
        return Response.json({ success: false, error: 'Valid numeric chatId is required' }, { status: 400 });
      }
      if (sourceChatId === chatId) {
        return Response.json({ success: false, error: 'sourceChatId and chatId must differ' }, { status: 400 });
      }

      const sourceSession = registry.getChat(sourceChatId);
      if (!sourceSession) {
        return Response.json({ success: false, error: 'Source session not found' }, { status: 404 });
      }

      if (!agents.supportsFork(sourceSession.agentId)) {
        return Response.json({ success: false, error: `Fork unsupported for agent: ${sourceSession.agentId}` }, { status: 422 });
      }

      const existingTarget = registry.getChat(chatId);
      if (existingTarget) {
        return Response.json({ success: false, error: `Session already exists: ${chatId}` }, { status: 409 });
      }

      const result = await forkChatFileCopy({
        sourceSession,
        sourceChatId,
        targetChatId: chatId,
        registry,
        settings,
        metadata,
        forkAgentSession: agents.forkAgentSession?.bind(agents),
        supportsFork: agents.supportsFork.bind(agents),
      });

      return Response.json({ success: true, ...result });
    } catch (error: unknown) {
      return Response.json({ success: false, error: (error as Error).message }, { status: 500 });
    }
  }

  async function postRunChat(body: Partial<AgentRunCommandRequest> & Record<string, unknown>): Promise<Response> {
    try {
      const clientRequestId = requireStringField(body, 'clientRequestId');
      const clientMessageId = requireStringField(body, 'clientMessageId');
      const chatId = requireStringField(body, 'chatId');
      const command = typeof body.command === 'string' ? body.command : '';
      const images = Array.isArray(body.images) ? body.images : undefined;
      if (!command.trim() && (!images || images.length === 0)) {
        return jsonError('command or images are required', 400);
      }
      const session = registry.getChat(chatId);
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
        transport: 'http',
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

  async function postForkRunChat(body: Partial<ForkRunCommandRequest> & Record<string, unknown>): Promise<Response> {
    try {
      const clientRequestId = requireStringField(body, 'clientRequestId');
      const clientMessageId = requireStringField(body, 'clientMessageId');
      const sourceChatId = requireStringField(body, 'sourceChatId');
      const chatId = requireStringField(body, 'chatId');
      const command = requireStringField(body, 'command');
      if (sourceChatId === chatId) return jsonError('sourceChatId and chatId must differ', 400);

      const sourceSession = registry.getChat(sourceChatId);
      if (!sourceSession) return jsonError('Source session not found', 404, 'SESSION_NOT_FOUND');
      if (!agents.supportsFork(sourceSession.agentId)) {
        return jsonError(`Fork unsupported for agent: ${sourceSession.agentId}`, 422, 'UNSUPPORTED_AGENT');
      }
      if (agents.isAgentSessionRunning(sourceSession.agentId, sourceSession.agentSessionId)) {
        return jsonError('Cannot fork a chat while it is processing', 409, 'SESSION_BUSY', true);
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
        transport: 'http',
        sourceChatId,
        chatId,
        command,
        images: Array.isArray(body.images) ? body.images : undefined,
        clientRequestId,
        clientMessageId,
        options,
        payload,
        ensureForked: async () => {
          if (registry.getChat(chatId)) return;
          await forkChatFileCopy({
            sourceSession,
            sourceChatId,
            targetChatId: chatId,
            registry,
            settings,
            metadata,
            forkAgentSession: agents.forkAgentSession?.bind(agents),
            supportsFork: agents.supportsFork.bind(agents),
          });
        },
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

  async function getRunningChats(): Promise<Response> {
    return Response.json({ sessions: agents.getRunningSessions() });
  }

  async function getQueue(_request: Request, url: URL): Promise<Response> {
    const chatId = url.searchParams.get('chatId');
    if (!chatId) return jsonError('chatId query parameter is required', 400);
    if (!registry.getChat(chatId)) return jsonError('Session not found', 404, 'SESSION_NOT_FOUND');
    const state = normalizeQueueState(await queue.readChatQueue(chatId));
    return Response.json({ success: true, chatId, queue: state });
  }

  async function postQueueEnqueue(body: Partial<QueueEnqueueCommandRequest> & Record<string, unknown>): Promise<Response> {
    try {
      const clientRequestId = requireStringField(body, 'clientRequestId');
      const chatId = requireStringField(body, 'chatId');
      const content = requireStringField(body, 'content');
      const result = await commands.submitQueueEnqueue({ chatId, content, clientRequestId });
      return Response.json(result, { status: 202 });
    } catch (error: unknown) {
      if (error instanceof CommandValidationError) {
        return jsonError(error.message, error.status, error.code, error.retryable);
      }
      return jsonError((error as Error).message, 500, 'INTERNAL_ERROR', true);
    }
  }

  async function postQueueMutation(body: QueueMutationRequest & Record<string, unknown>, action: 'dequeue' | 'clear' | 'pause' | 'resume'): Promise<Response> {
    try {
      const chatId = requireStringField(body, 'chatId');
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

  async function postPermissionDecision(body: Partial<PermissionDecisionCommandRequest> & Record<string, unknown>): Promise<Response> {
    try {
      const clientRequestId = requireStringField(body, 'clientRequestId');
      const chatId = requireStringField(body, 'chatId');
      const permissionRequestId = requireStringField(body, 'permissionRequestId');
      const result = await commands.submitPermissionDecision({
        chatId,
        permissionRequestId,
        allow: Boolean(body.allow),
        alwaysAllow: Boolean(body.alwaysAllow),
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
      return jsonError((error as Error).message, 500, 'INTERNAL_ERROR', true);
    }
  }

  async function patchExecutionSettings(body: ExecutionSettingsPatchRequest & Record<string, unknown>): Promise<Response> {
    try {
      const chatId = requireStringField(body, 'chatId');
      if (!registry.getChat(chatId)) return jsonError('Session not found', 404, 'SESSION_NOT_FOUND');
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
      return jsonError((error as Error).message, 500, 'INTERNAL_ERROR', true);
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
      if (modelProtocol !== undefined) patch.modelProtocol = modelProtocol as AgentSessionSettingsPatch['modelProtocol'];
      await agents.updateSessionSettings(chatId, patch);
      return Response.json({ success: true, chatId, ...patch });
    } catch (error: unknown) {
      return jsonError((error as Error).message, 500, 'INTERNAL_ERROR', true);
    }
  }

  return {
    '/api/v1/chats': { GET: getChats, DELETE: deleteSessionHandler },
    '/api/v1/chats/start': { POST: withJsonBody(postStartSession) },
    '/api/v1/chats/run': { POST: withJsonBody(postRunChat) },
    '/api/v1/chats/validate-start': { GET: validateStartPath },
    '/api/v1/chats/fork': { POST: withJsonBody(postForkChat) },
    '/api/v1/chats/fork-run': { POST: withJsonBody(postForkRunChat) },
    '/api/v1/chats/messages': { GET: getMessages },
    '/api/v1/chats/running': { GET: getRunningChats },
    '/api/v1/chats/queue': { GET: getQueue },
    '/api/v1/chats/queue/enqueue': { POST: withJsonBody(postQueueEnqueue) },
    '/api/v1/chats/queue/dequeue': { POST: withJsonBody((body) => postQueueMutation(body, 'dequeue')) },
    '/api/v1/chats/queue/clear': { POST: withJsonBody((body) => postQueueMutation(body, 'clear')) },
    '/api/v1/chats/queue/pause': { POST: withJsonBody((body) => postQueueMutation(body, 'pause')) },
    '/api/v1/chats/queue/resume': { POST: withJsonBody((body) => postQueueMutation(body, 'resume')) },
    '/api/v1/chats/permissions/decision': { POST: withJsonBody(postPermissionDecision) },
    '/api/v1/chats/stop': { POST: withJsonBody(postStopChat) },
    '/api/v1/chats/execution-settings': { PATCH: withJsonBody(patchExecutionSettings) },
    '/api/v1/chats/model': { PATCH: withJsonBody(patchModel) },
    '/api/v1/chats/details': { GET: getChatDetails },
    '/api/v1/chats/pin': { POST: postTogglePin },
    '/api/v1/chats/archive': { POST: postToggleArchive },
    '/api/v1/chats/read': { POST: withJsonBody(postMarkRead) },
    '/api/v1/chats/reorder': { POST: withJsonBody(postReorderChats) },
    '/api/v1/chats/reorder-quick': { POST: withJsonBody(postReorderQuick) },
    '/api/v1/chats/tags': { PATCH: withJsonBody(patchChatTags) },
  };
}
