// /api/chats/* route handlers. Provides CRUD for the session registry
// and dispatches message reads to the appropriate provider parser.

import { promises as fs } from 'fs';
import path from 'path';
import { parseJsonBody } from '../lib/http-native.js';
import { maybeGenerateChatTitle } from '../chats/title-generator.js';
import { UserMessage } from '../../common/chat-types.ts';
import { resolveMissingNativePath } from '../chats/resolve-native-path.js';
import { forkChatFileCopy } from '../chats/fork-chat.js';
import { PROVIDERS as VALID_PROVIDERS, supportsFork as providerSupportsFork, supportsImages as providerSupportsImages } from '../../common/providers.ts';
import { getProjectBasePath } from '../config.js';

const PROJECT_BASE_PATH = getProjectBasePath();

function isWithinBasePath(targetPath) {
  const resolved = path.resolve(targetPath);
  const projectBasePathPrefix = PROJECT_BASE_PATH.endsWith(path.sep) ? PROJECT_BASE_PATH : PROJECT_BASE_PATH + path.sep;
  return resolved === PROJECT_BASE_PATH || resolved.startsWith(projectBasePathPrefix);
}

async function isGitRepository(projectPath) {
  try {
    const proc = Bun.spawn(['git', 'rev-parse', '--is-inside-work-tree'], {
      cwd: projectPath,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, exitCode] = await Promise.all([proc.stdout.text(), proc.exited]);
    return exitCode === 0 && stdout.trim() === 'true';
  } catch {
    return false;
  }
}

function createdAtFromId(id) {
  const raw = String(id || '').trim();
  if (!/^\d+$/.test(raw)) return null;
  const msString = raw.length > 13 ? raw.slice(0, -3) : raw;
  const ts = parseInt(msString, 10);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  return new Date(ts).toISOString();
}

function extractFirstLine(text) {
  if (!text) return '';
  const nl = text.indexOf('\n');
  if (nl < 0) return text.trim();
  return text.slice(0, nl).trim();
}

export default function createChatRoutes(registry, settings, queue, pathCache, metadata, historyCache, providers) {

  async function validateStartPath(request, url) {
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
    } catch (error) {
      if (error.code === 'ENOENT') {
        return Response.json({ valid: false, error: 'Path does not exist', errorCode: 'path_not_found' });
      }
      if (error.code === 'EACCES' || error.code === 'EPERM') {
        return Response.json({ valid: false, error: 'Permission denied', errorCode: 'permission_denied' });
      }
      return Response.json({ valid: false, error: error.message, errorCode: 'unknown' });
    }
  }

  async function getChats() {
    try {
      const sessions = registry.listAllChats();
      const metadataMap = metadata.listAllChatMetadata();

      let pinnedList, normalList, archivedList;
      try { pinnedList = await settings.getPinnedChatIds(); } catch { pinnedList = []; }
      try { normalList = await settings.getNormalChatIds(); } catch { normalList = []; }
      try { archivedList = await settings.getArchivedChatIds(); } catch { archivedList = []; }

      const pinnedIds = new Set(pinnedList);
      const archivedIds = new Set(archivedList);

      // Build entry map for all visible sessions.
      const entryMap = new Map();
      for (const chatId in sessions) {
        const session = sessions[chatId];
        if (!await pathCache.isProjectPathAvailable(session.projectPath)) continue;
        const meta = metadataMap.get(chatId) || null;
        const inferredCreatedAt = createdAtFromId(chatId);
        const overrideTitle = settings.getChatName(chatId);
        const isPinned = pinnedIds.has(chatId);
        const isArchived = !isPinned && archivedIds.has(chatId);
        const lastReadAt = session.lastReadAt || null;
        const lastActivityAt = meta?.lastActivity || null;
        const isUnread = Boolean(lastActivityAt && (!lastReadAt || lastActivityAt > lastReadAt));

        entryMap.set(chatId, {
          id: chatId,
          provider: session.provider,
          model: session.model || null,
          permissionMode: session.permissionMode || 'default',
          thinkingMode: session.thinkingMode || 'none',
          title: extractFirstLine(overrideTitle || meta?.firstMessage || 'New Session'),
          projectPath: session.projectPath,
          tags: session.tags || [],
          activity: { createdAt: meta?.createdAt || inferredCreatedAt, lastActivityAt, lastReadAt },
          preview: { lastMessage: extractFirstLine(meta?.lastMessage) },
          isActive: providers.isProviderSessionRunning(session.provider, session.providerSessionId),
          isPinned,
          isArchived,
          isUnread,
        });
      }

      // Emit chats in persisted order, skipping IDs that don't map to visible sessions.
      const orderedFromList = (list) => list.map((id) => entryMap.get(id)).filter(Boolean);

      const pinned = orderedFromList(pinnedList);
      const normal = orderedFromList(normalList);
      const archived = orderedFromList(archivedList);

      // Safety net: include chats that exist in the registry but are missing
      // from all order lists (can happen if a concurrent settings write
      // clobbered the ensureInNormal update during chat creation).
      const listed = new Set([...pinnedList, ...normalList, ...archivedList]);
      const orphans = [];
      for (const [id, entry] of entryMap) {
        if (!listed.has(id)) orphans.push(entry);
      }
      if (orphans.length > 0) {
        // Sort newest-first so they appear at the top of the normal section.
        orphans.sort((a, b) => (b.activity.createdAt || '').localeCompare(a.activity.createdAt || ''));
        // Lazily repair the order list so subsequent fetches are consistent.
        for (const entry of orphans) {
          settings.ensureInNormal(entry.id).catch((err) => {
            console.warn(`chats: failed to repair orphan ${entry.id}:`, err.message);
          });
        }
      }

      const all = [...pinned, ...orphans, ...normal, ...archived];
      return Response.json({ sessions: all, total: all.length });
    } catch (error) {
      console.error('sessions: error listing sessions:', error.message);
      return Response.json({ success: false, error: error.message }, { status: 500 });
    }
  }

  async function postStartSession(request) {
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
      const initialImages = Array.isArray(requestOptions.images) ? requestOptions.images : [];

      if (!chatId || !/^\d+$/.test(chatId)) {
        return Response.json({ success: false, error: 'Valid numeric chatId is required' }, { status: 400 });
      }
      if (initialImages.length > 0 && !providerSupportsImages(provider)) {
        return Response.json({ success: false, error: `Images unsupported for provider: ${provider}` }, { status: 422 });
      }
      if (!projectPath) {
        return Response.json({ success: false, error: 'projectPath is required' }, { status: 400 });
      }
      // TODO: use path-cache
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

      const model = body.model || null;

      const permissionMode =
        typeof requestOptions.permissionMode === 'string'
          ? requestOptions.permissionMode
          : 'default';

      const thinkingMode =
        typeof requestOptions.thinkingMode === 'string'
          ? requestOptions.thinkingMode
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

      await settings.ensureInNormal(chatId);

      historyCache.appendMessages(chatId, [
        new UserMessage(new Date().toISOString(), command, initialImages.length > 0 ? initialImages : undefined),
      ]).catch((err) => {
        console.warn(`sessions: failed to append initial user message for ${chatId}:`, err.message);
      });

      try {
        await providers.startSession(chatId, command, {
          ...requestOptions,
          cwd: projectPath,
          projectPath,
        });
      } catch (error) {
        registry.removeChat(chatId);
        return Response.json({ success: false, error: error.message }, { status: 500 });
      }

      // Fire-and-forget title generation; non-blocking for chat startup.
      void maybeGenerateChatTitle({ chatId, projectPath, firstPrompt: command, providers, settings });

      return Response.json({
        success: true,
        chatId,
        provider,
        status: 'initialized',
      });
    } catch (error) {
      if (error.message === 'Malformed JSON') {
        return Response.json({ success: false, error: 'Malformed JSON' }, { status: 400 });
      }
      return Response.json({ success: false, error: error.message }, { status: 500 });
    }
  }

  async function deleteSessionHandler(request, url) {
    const chatId = url.searchParams.get('chatId');
    if (!chatId) return Response.json({ error: 'chatId query parameter is required' }, { status: 400 });

    try {
      const session = registry.getChat(chatId);
      if (!session) {
        return Response.json({ success: false, error: 'Session not found' }, { status: 404 });
      }

      if (session.nativePath) {
        try {
          await fs.unlink(session.nativePath);
        } catch (error) {
          if (error.code !== 'ENOENT') {
            console.warn(`sessions: could not delete native file ${session.nativePath}:`, error.message);
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
      } catch { }

      try {
        await settings.removeSessionName(chatId);
      } catch { }

      return Response.json({ success: true });
    } catch (error) {
      return Response.json({ success: false, error: error.message }, { status: 500 });
    }
  }

  async function getMessages(request, url) {
    const chatId = url.searchParams.get('chatId');
    if (!chatId) return Response.json({ error: 'chatId query parameter is required' }, { status: 400 });

    try {
      const session = registry.getChat(chatId);
      if (!session) {
        return Response.json({ success: false, error: 'Session not found' }, { status: 404 });
      }
      if (!session.nativePath) {
        const resolvedPath = await resolveMissingNativePath(session);
        if (!resolvedPath) {
          return Response.json({ messages: [], total: 0, hasMore: false, offset: 0, limit: 20 });
        }
        session.nativePath = resolvedPath;
        registry.updateChat(chatId, { nativePath: resolvedPath });
      }

      const limit = parseInt(url.searchParams.get('limit') || '20', 10);
      const offset = parseInt(url.searchParams.get('offset') || '0', 10);

      await historyCache.ensureLoaded(chatId);
      return Response.json(historyCache.getPaginatedMessages(chatId, limit, offset));
    } catch (error) {
      console.error(`sessions: error reading messages for ${chatId}:`, error.message);
      return Response.json({ success: false, error: error.message }, { status: 500 });
    }
  }

  async function getChatDetails(request, url) {
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
    } catch (error) {
      return Response.json({ success: false, error: error.message }, { status: 500 });
    }
  }

  async function postTogglePin(request, url) {
    const chatId = url.searchParams.get('chatId');
    if (!chatId) return Response.json({ error: 'chatId query parameter is required' }, { status: 400 });

    try {
      const session = registry.getChat(chatId);
      if (!session) {
        return Response.json({ success: false, error: 'Session not found' }, { status: 404 });
      }

      const result = await settings.togglePin(chatId);
      return Response.json({ success: true, isPinned: result.isPinned });
    } catch (error) {
      return Response.json({ success: false, error: error.message }, { status: 500 });
    }
  }

  async function postToggleArchive(request, url) {
    const chatId = url.searchParams.get('chatId');
    if (!chatId) return Response.json({ error: 'chatId query parameter is required' }, { status: 400 });

    try {
      const session = registry.getChat(chatId);
      if (!session) {
        return Response.json({ success: false, error: 'Session not found' }, { status: 404 });
      }

      const result = await settings.toggleArchive(chatId);
      return Response.json({ success: true, isArchived: result.isArchived });
    } catch (error) {
      return Response.json({ success: false, error: error.message }, { status: 500 });
    }
  }

  // Batch marks chats as read with monotonic merge.
  async function postMarkRead(request) {
    try {
      const body = await parseJsonBody(request);
      const entries = Array.isArray(body.entries) ? body.entries : [];
      if (entries.length === 0) {
        return Response.json({ success: true, results: [] });
      }

      const now = new Date().toISOString();
      const results = [];
      for (const entry of entries) {
        const chatId = String(entry.chatId || '').trim();
        if (!chatId) continue;

        const session = registry.getChat(chatId);
        if (!session) continue;

        const incoming = entry.lastReadAt || now;
        const existing = session.lastReadAt || null;
        const merged = existing && existing > incoming ? existing : incoming;

        registry.updateChat(chatId, { lastReadAt: merged });
        results.push({ chatId, lastReadAt: merged });
      }

      return Response.json({ success: true, results });
    } catch (error) {
      if (error.message === 'Malformed JSON') {
        return Response.json({ success: false, error: 'Malformed JSON' }, { status: 400 });
      }
      return Response.json({ success: false, error: error.message }, { status: 500 });
    }
  }

  // Persists a window reorder within a specified group.
  async function postReorderChats(request) {
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
    } catch (error) {
      if (error.message === 'Malformed JSON') {
        return Response.json({ success: false, error: 'Malformed JSON' }, { status: 400 });
      }
      return Response.json({ success: false, error: error.message }, { status: 500 });
    }
  }

  // Moves a single chat relative to a neighbor within the same group.
  async function postReorderQuick(request) {
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
        const status = result.error.includes('not found') ? 404 : 400;
        return Response.json({ success: false, error: result.error }, { status });
      }

      return Response.json({ success: true });
    } catch (error) {
      if (error.message === 'Malformed JSON') {
        return Response.json({ success: false, error: 'Malformed JSON' }, { status: 400 });
      }
      return Response.json({ success: false, error: error.message }, { status: 500 });
    }
  }

  async function postForkChat(request) {
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

      if (!providerSupportsFork(sourceSession.provider)) {
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
    } catch (error) {
      if (error.message === 'Malformed JSON') {
        return Response.json({ success: false, error: 'Malformed JSON' }, { status: 400 });
      }
      return Response.json({ success: false, error: error.message }, { status: 500 });
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
