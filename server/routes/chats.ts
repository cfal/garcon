// /api/chats/* route handlers. Provides CRUD for the session registry
// and dispatches message reads to the appropriate provider parser.

import { promises as fs } from 'fs';
import path from 'path';
import { parseJsonBody } from '../lib/http-native.js';
import { maybeGenerateChatTitle } from '../chats/title-generator.js';
import { UserMessage } from '../../common/chat-types.ts';
import { forkChatFileCopy } from '../chats/fork-chat.js';
import { PROVIDERS as VALID_PROVIDERS, supportsFork as providerSupportsFork, supportsImages as providerSupportsImages } from '../../common/providers.ts';
import { getProjectBasePath } from '../config.js';

const PROJECT_BASE_PATH = getProjectBasePath();

type RouteHandler = (request: Request, url: URL) => Promise<Response> | Response;
type RouteMap = Record<string, Record<string, RouteHandler>>;

interface ChatRegistryDep {
  getChat(chatId: string): Record<string, unknown> | null;
  listAllChats(): Record<string, Record<string, unknown>>;
  addChat(entry: Record<string, unknown>): boolean;
  removeChat(chatId: string): void;
  updateChat(chatId: string, updates: Record<string, unknown>): void;
}

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

interface ProvidersDep {
  isProviderSessionRunning(provider: string, providerSessionId: string | null | undefined): boolean;
  startSession(chatId: string, command: string, opts: Record<string, unknown>): Promise<void>;
  runSingleQuery(prompt: string, opts?: Record<string, unknown>): Promise<string>;
}

function isWithinBasePath(targetPath: string): boolean {
  const resolved = path.resolve(targetPath);
  const projectBasePathPrefix = PROJECT_BASE_PATH.endsWith(path.sep) ? PROJECT_BASE_PATH : PROJECT_BASE_PATH + path.sep;
  return resolved === PROJECT_BASE_PATH || resolved.startsWith(projectBasePathPrefix);
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

export default function createChatRoutes(
  registry: ChatRegistryDep,
  settings: SettingsDep,
  queue: QueueDep,
  pathCache: PathCacheDep,
  metadata: MetadataDep,
  historyCache: HistoryCacheDep,
  providers: ProvidersDep,
): RouteMap {

  async function validateStartPath(_request: Request, url: URL): Promise<Response> {
    const dirPath = String(url.searchParams.get('path') || '').trim();
    if (!dirPath) {
      return Response.json(
        { valid: false, error: 'path is required', errorCode: 'path_required' },
        { status: 400 },
      );
    }

    if (!isWithinBasePath(dirPath)) {
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

      const entryMap = new Map<string, Record<string, unknown>>();
      for (const chatId in sessions) {
        const session = sessions[chatId];
        if (!await pathCache.isProjectPathAvailable(session.projectPath as string)) continue;
        const meta = metadataMap.get(chatId) || null;
        const inferredCreatedAt = createdAtFromId(chatId);
        const overrideTitle = settings.getChatName(chatId);
        const isPinned = pinnedIds.has(chatId);
        const isArchived = !isPinned && archivedIds.has(chatId);
        const lastReadAt = (session.lastReadAt as string) || null;
        const lastActivityAt = (meta?.lastActivity as string) || null;
        const isUnread = Boolean(lastActivityAt && (!lastReadAt || lastActivityAt > lastReadAt));

        entryMap.set(chatId, {
          id: chatId,
          provider: session.provider,
          model: session.model || null,
          permissionMode: session.permissionMode || 'default',
          thinkingMode: session.thinkingMode || 'none',
          title: extractFirstLine((overrideTitle || meta?.firstMessage || 'New Session') as string),
          projectPath: session.projectPath,
          tags: session.tags || [],
          activity: { createdAt: (meta?.createdAt as string) || inferredCreatedAt, lastActivityAt, lastReadAt },
          preview: { lastMessage: extractFirstLine(meta?.lastMessage as string) },
          isActive: providers.isProviderSessionRunning(session.provider as string, session.providerSessionId as string | null),
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
        for (const entry of orphans) {
          settings.ensureInNormal(entry.id as string).catch((err: Error) => {
            console.warn(`chats: failed to repair orphan ${entry.id}:`, err.message);
          });
        }
      }

      const all = [...pinned, ...orphans, ...normal, ...archived];
      return Response.json({ sessions: all, total: all.length });
    } catch (error: unknown) {
      console.error('sessions: error listing sessions:', (error as Error).message);
      return Response.json({ success: false, error: (error as Error).message }, { status: 500 });
    }
  }

  async function postStartSession(request: Request): Promise<Response> {
    try {
      const body = await parseJsonBody(request);
      const chatId = String(body.chatId || '').trim();
      const provider = typeof body.provider === 'string' && VALID_PROVIDERS.includes(body.provider)
        ? body.provider
        : 'claude';
      const projectPath = String(body.projectPath || '').trim();
      const command = String(body.command || '').trim();
      const tags = Array.isArray(body.tags) ? body.tags : [provider];
      const requestOptions = body.options && typeof body.options === 'object' ? body.options : {};
      const initialImages = Array.isArray((requestOptions as Record<string, unknown>).images) ? (requestOptions as Record<string, unknown>).images as unknown[] : [];

      if (!chatId || !/^\d+$/.test(chatId)) {
        return Response.json({ success: false, error: 'Valid numeric chatId is required' }, { status: 400 });
      }
      if (initialImages.length > 0 && !providerSupportsImages(provider)) {
        return Response.json({ success: false, error: `Images unsupported for provider: ${provider}` }, { status: 422 });
      }
      if (!projectPath) {
        return Response.json({ success: false, error: 'projectPath is required' }, { status: 400 });
      }
      try {
        await fs.access(projectPath);
      } catch {
        return Response.json({ success: false, error: `Project path not found: ${projectPath}` }, { status: 404 });
      }

      if (!command) {
        return Response.json({ success: false, error: 'command is required' }, { status: 400 });
      }

      const existing = registry.getChat(chatId);
      if (existing) {
        return Response.json(
          {
            success: false,
            error: `Session already exists: ${chatId}`,
            chatId,
            provider: existing.provider,
          },
          { status: 409 },
        );
      }

      const model = typeof body.model === 'string' ? body.model : '';

      const permissionMode =
        typeof body.permissionMode === 'string'
          ? body.permissionMode
          : 'default';

      const thinkingMode =
        typeof body.thinkingMode === 'string'
          ? body.thinkingMode
          : 'none';

      const created = registry.addChat({
        id: chatId,
        provider,
        nativePath: null,
        projectPath,
        tags,
        providerSessionId: null,
        model,
        permissionMode,
        thinkingMode,
      });
      if (!created) {
        return Response.json({ success: false, error: `Session ID collision: ${chatId}` }, { status: 409 });
      }
      metadata.addNewChatMetadata(chatId, command);

      await settings.setLastChatDefaults({
        provider,
        projectPath,
        model,
        permissionMode,
        thinkingMode,
      });
      await settings.ensureInNormal(chatId);

      historyCache.appendMessages(chatId, [
        new UserMessage(new Date().toISOString(), command, initialImages.length > 0 ? initialImages as any : undefined),
      ]).catch((err: Error) => {
        console.warn(`sessions: failed to append initial user message for ${chatId}:`, err.message);
      });

      try {
        await providers.startSession(chatId, command, {
          ...(requestOptions as Record<string, unknown>),
          projectPath,
        });
      } catch (error: unknown) {
        registry.removeChat(chatId);
        try {
          await settings.removeFromAllOrderLists(chatId);
        } catch (cleanupError: unknown) {
          console.warn(`sessions: failed to remove ${chatId} from order lists after startup failure:`, (cleanupError as Error).message);
        }
        return Response.json({ success: false, error: (error as Error).message }, { status: 500 });
      }

      void maybeGenerateChatTitle({ chatId, projectPath, firstPrompt: command, providers, settings });

      return Response.json({
        success: true,
        chatId,
        provider,
        status: 'initialized',
      });
    } catch (error: unknown) {
      if ((error as Error).message === 'Malformed JSON') {
        return Response.json({ success: false, error: 'Malformed JSON' }, { status: 400 });
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

      if (session.nativePath) {
        try {
          await fs.unlink(session.nativePath as string);
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            console.warn(`sessions: could not delete native file ${session.nativePath}:`, (error as Error).message);
          }
        }
      }

      try {
        await queue.deleteChatQueueFile(chatId);
      } catch {
        // Queue file may not exist.
      }

      registry.removeChat(chatId);

      try {
        await settings.removeFromAllOrderLists(chatId);
      } catch { /* ignore */ }

      try {
        await settings.removeSessionName(chatId);
      } catch { /* ignore */ }

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

      const limit = parseInt(url.searchParams.get('limit') || '20', 10);
      const offset = parseInt(url.searchParams.get('offset') || '0', 10);

      await historyCache.ensureLoaded(chatId);
      return Response.json(historyCache.getPaginatedMessages(chatId, limit, offset));
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

  async function postMarkRead(request: Request): Promise<Response> {
    try {
      const body = await parseJsonBody(request);
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
      if ((error as Error).message === 'Malformed JSON') {
        return Response.json({ success: false, error: 'Malformed JSON' }, { status: 400 });
      }
      return Response.json({ success: false, error: (error as Error).message }, { status: 500 });
    }
  }

  async function postReorderChats(request: Request): Promise<Response> {
    try {
      const body = await parseJsonBody(request);
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
      if ((error as Error).message === 'Malformed JSON') {
        return Response.json({ success: false, error: 'Malformed JSON' }, { status: 400 });
      }
      return Response.json({ success: false, error: (error as Error).message }, { status: 500 });
    }
  }

  async function postReorderQuick(request: Request): Promise<Response> {
    try {
      const body = await parseJsonBody(request);
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
      if ((error as Error).message === 'Malformed JSON') {
        return Response.json({ success: false, error: 'Malformed JSON' }, { status: 400 });
      }
      return Response.json({ success: false, error: (error as Error).message }, { status: 500 });
    }
  }

  async function postForkChat(request: Request): Promise<Response> {
    try {
      const body = await parseJsonBody(request);
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

      if (!providerSupportsFork(sourceSession.provider as import('../../common/providers.ts').ProviderId)) {
        return Response.json({ success: false, error: `Fork unsupported for provider: ${sourceSession.provider}` }, { status: 422 });
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
      });

      return Response.json({ success: true, ...result });
    } catch (error: unknown) {
      if ((error as Error).message === 'Malformed JSON') {
        return Response.json({ success: false, error: 'Malformed JSON' }, { status: 400 });
      }
      return Response.json({ success: false, error: (error as Error).message }, { status: 500 });
    }
  }

  return {
    '/api/v1/chats': { GET: getChats, DELETE: deleteSessionHandler },
    '/api/v1/chats/start': { POST: postStartSession },
    '/api/v1/chats/validate-start': { GET: validateStartPath },
    '/api/v1/chats/fork': { POST: postForkChat },
    '/api/v1/chats/messages': { GET: getMessages },
    '/api/v1/chats/details': { GET: getChatDetails },
    '/api/v1/chats/pin': { POST: postTogglePin },
    '/api/v1/chats/archive': { POST: postToggleArchive },
    '/api/v1/chats/read': { POST: postMarkRead },
    '/api/v1/chats/reorder': { POST: postReorderChats },
    '/api/v1/chats/reorder-quick': { POST: postReorderQuick },
  };
}
