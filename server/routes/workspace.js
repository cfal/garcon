import { parseJsonBody } from '../lib/http-request.js';
import { getProjectBasePath, getTelegramBotToken } from '../config.js';
import { AMP_MODELS, CLAUDE_MODELS, CODEX_MODELS, FACTORY_MODELS, OPENROUTER_MODELS, ZAI_MODELS } from '../../common/models.js';
import { resolveEffectiveGenerationUiConfig } from '../settings/generation-effective.js';

// Builds the canonical remote settings snapshot used by GET, PUT, and
// WebSocket broadcast paths. Single source of truth for the shape.
export async function buildRemoteSettingsSnapshot({ settings, providers }) {
  function asPlainObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function sanitizeRemoteUiSnapshot(value) {
    // Removes browser-local sidebar layout state from the shared snapshot.
    const ui = asPlainObject(value);
    if (!('searchBarPosition' in ui)) return ui;
    const { searchBarPosition: _legacySearchBarPosition, ...rest } = ui;
    return rest;
  }

  const settingsSource = typeof settings.getRemoteSettingsSnapshotSource === 'function'
    ? await settings.getRemoteSettingsSnapshotSource()
    : null;

  const [
    authByProvider, opencodeModels, factoryModels, openrouterModels, zaiModels,
  ] = await Promise.all([
    providers?.getAuthStatusMap?.() ?? Promise.resolve({
      claude: { authenticated: false },
      codex: { authenticated: false },
      opencode: { authenticated: false },
      amp: { authenticated: false },
      factory: { authenticated: false },
      openrouter: { authenticated: false },
      zai: { authenticated: false },
    }),
    providers?.getModels?.('opencode') ?? Promise.resolve([]),
    providers?.getModels?.('factory') ?? Promise.resolve([]),
    providers?.getModels?.('openrouter') ?? Promise.resolve([]),
    providers?.getModels?.('zai') ?? Promise.resolve([]),
  ]);

  const [
    version, ui, paths, pinnedChatIds, lastProvider, lastProjectPath, lastModel,
    lastPermissionMode, lastThinkingMode, lastClaudeThinkingMode, lastAmpAgentMode,
  ] = settingsSource
    ? [
      settingsSource.version,
      sanitizeRemoteUiSnapshot(settingsSource.ui),
      settingsSource.paths,
      settingsSource.pinnedChatIds,
      settingsSource.lastProvider,
      settingsSource.lastProjectPath,
      settingsSource.lastModel,
      settingsSource.lastPermissionMode,
      settingsSource.lastThinkingMode,
      settingsSource.lastClaudeThinkingMode,
      settingsSource.lastAmpAgentMode,
    ]
    : await Promise.all([
      settings.getRemoteSettingsVersion(),
      settings.getUiSettings(),
      settings.getPathSettings(),
      settings.getPinnedChatIds(),
      settings.getLastProvider(),
      settings.getLastProjectPath(),
      settings.getLastModel(),
      settings.getLastPermissionMode(),
      settings.getLastThinkingMode(),
      settings.getLastClaudeThinkingMode(),
      settings.getLastAmpAgentMode(),
    ]);

  const modelsByProvider = {
    claude: CLAUDE_MODELS.OPTIONS,
    codex: CODEX_MODELS.OPTIONS,
    opencode: Array.isArray(opencodeModels) ? opencodeModels : [],
    amp: AMP_MODELS.OPTIONS,
    factory: Array.isArray(factoryModels) ? factoryModels : FACTORY_MODELS.OPTIONS,
    openrouter: Array.isArray(openrouterModels) ? openrouterModels : OPENROUTER_MODELS.OPTIONS,
    zai: Array.isArray(zaiModels) ? zaiModels : ZAI_MODELS.OPTIONS,
  };

  const uiEffective = {
    chatTitle: resolveEffectiveGenerationUiConfig({
      persisted: asPlainObject(ui?.chatTitle),
      authByProvider,
      modelsByProvider,
    }),
    commitMessage: resolveEffectiveGenerationUiConfig({
      persisted: asPlainObject(ui?.commitMessage),
      authByProvider,
      modelsByProvider,
    }),
  };

  return {
    version,
    ui: sanitizeRemoteUiSnapshot(ui),
    uiEffective,
    paths: {
      pinnedProjectPaths: Array.isArray(paths?.pinnedProjectPaths)
        ? paths.pinnedProjectPaths.filter((entry) => typeof entry === 'string')
        : [],
      browseStartPath: typeof paths?.browseStartPath === 'string' ? paths.browseStartPath : '',
    },
    pinnedChatIds: Array.isArray(pinnedChatIds) ? pinnedChatIds : [],
    lastProvider,
    lastProjectPath,
    lastModel,
    lastPermissionMode,
    lastThinkingMode,
    lastClaudeThinkingMode,
    lastAmpAgentMode,
    projectBasePath: getProjectBasePath(),
    telegramBotTokenAvailable: Boolean(getTelegramBotToken()),
  };
}

export default function createWorkspaceRoutes(settings, providers, telegramNotifier) {

  const FILTER_KEYS = ['textTokens', 'tags', 'providers', 'models'];
  const VALID_FILTER_STATUS = new Set(['active', 'unread']);
  function sanitizeRemoteUiPatch(raw) {
    // Drops legacy browser-local fields before persisting shared settings.
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const { searchBarPosition: _legacySearchBarPosition, ...rest } = raw;
    return Object.keys(rest).length > 0 ? rest : null;
  }
	function sanitizeFilter(raw) {
    const empty = { textTokens: [], tags: [], providers: [], models: [] };
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return empty;
    const out = {};
		for (const key of FILTER_KEYS) {
			out[key] = Array.isArray(raw[key])
        ? raw[key].filter((v) => typeof v === 'string').map((v) => v.trim()).filter(Boolean)
				: [];
    }
		if (typeof raw.status === 'string') {
			const status = raw.status.trim();
			if (VALID_FILTER_STATUS.has(status)) out.status = status;
		}
		return out;
	}

  async function putSessionNameHandler(request) {
    try {
      const { chatId, title } = await parseJsonBody(request);
      if (!chatId || typeof chatId !== 'string') {
        return Response.json({ success: false, error: 'chatId is required' }, { status: 400 });
      }
      const trimmed = typeof title === 'string' ? title.trim() : '';
      if (!trimmed) {
        return Response.json({ success: false, error: 'title is required' }, { status: 400 });
      }
      // setSessionName emits 'session-name-changed' for broadcast wiring.
      await settings.setSessionName(chatId, trimmed);
      return Response.json({ success: true });
    } catch (error) {
      return Response.json({ success: false, error: error.message }, { status: 500 });
    }
  }

  async function getAppSettings() {
    try {
      const snapshot = await buildRemoteSettingsSnapshot({ settings, providers });
      return Response.json(snapshot);
    } catch (error) {
      return Response.json({ success: false, error: error.message }, { status: 500 });
    }
  }

  async function putAppSettings(request) {
    try {
      const body = await parseJsonBody(request);

      const uiPatch = sanitizeRemoteUiPatch(body.ui);
      if (uiPatch) {
        await settings.setUiSettings(uiPatch);
      }

      if (body.paths && typeof body.paths === 'object') {
        await settings.setPathSettings(body.paths);
      }

      const snapshot = await buildRemoteSettingsSnapshot({ settings, providers });
      return Response.json({ success: true, settings: snapshot });
    } catch (error) {
      if (error.message === 'Malformed JSON') {
        return Response.json({ success: false, error: 'Malformed JSON' }, { status: 400 });
      }
      return Response.json({ success: false, error: error.message }, { status: 500 });
    }
  }

  async function postTelegramTest(request) {
    try {
      if (!telegramNotifier?.isConfigured) {
        return Response.json({ success: false, error: 'GARCON_TELEGRAM_BOT_TOKEN is not set' }, { status: 400 });
      }
      const body = await parseJsonBody(request);
      const chatId = typeof body.chatId === 'string' ? body.chatId.trim() : '';
      if (!chatId) {
        return Response.json({ success: false, error: 'chatId is required' }, { status: 400 });
      }
      const ok = await telegramNotifier.send(chatId, 'Garcon: test notification. Your Telegram integration is working.');
      if (!ok) {
        return Response.json({ success: false, error: 'Telegram delivery failed. Check your bot token and chat ID.' }, { status: 502 });
      }
      return Response.json({ success: true });
    } catch (error) {
      if (error.message === 'Malformed JSON') {
        return Response.json({ success: false, error: 'Malformed JSON' }, { status: 400 });
      }
      return Response.json({ success: false, error: error.message }, { status: 500 });
    }
  }

  function sanitizeSavedSearchInput(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const titleRaw = typeof raw.title === 'string' ? raw.title.trim() : '';
    const query = typeof raw.query === 'string' ? raw.query.trim() : '';
    const showAsSidebarPill = raw.showAsSidebarPill === true;
    const showInSidebarMenu = raw.showInSidebarMenu === true;
    const showInSearchDialog = raw.showInSearchDialog === true;
    return { title: titleRaw || null, query, showAsSidebarPill, showInSidebarMenu, showInSearchDialog };
  }

  function hasAnySavedSearchVisibility(input) {
    return input.showAsSidebarPill || input.showInSidebarMenu || input.showInSearchDialog;
  }

  async function getSavedSearches() {
    try {
      const savedSearches = await settings.getSavedSearches();
      return Response.json({ savedSearches });
    } catch (error) {
      return Response.json({ success: false, error: error.message }, { status: 500 });
    }
  }

  async function postSavedSearch(request) {
    try {
      const body = await parseJsonBody(request);
      const input = sanitizeSavedSearchInput(body);
      if (!input || !input.query) {
        return Response.json({ success: false, error: 'query is required' }, { status: 400 });
      }
      if (!hasAnySavedSearchVisibility(input)) {
        return Response.json({ success: false, error: 'at least one visibility option is required' }, { status: 400 });
      }
      const now = new Date().toISOString();
      const savedSearch = {
        id: crypto.randomUUID(),
        title: input.title,
        query: input.query,
        showAsSidebarPill: input.showAsSidebarPill,
        showInSidebarMenu: input.showInSidebarMenu,
        showInSearchDialog: input.showInSearchDialog,
        createdAt: now,
        updatedAt: now,
      };
      const result = await settings.addSavedSearch(savedSearch);
      return Response.json({ success: true, savedSearch: result });
    } catch (error) {
      if (error.message === 'Malformed JSON') {
        return Response.json({ success: false, error: 'Malformed JSON' }, { status: 400 });
      }
      return Response.json({ success: false, error: error.message }, { status: 500 });
    }
  }

  async function putSavedSearch(request) {
    try {
      const body = await parseJsonBody(request);
      const id = String(body.id || '').trim();
      if (!id) {
        return Response.json({ success: false, error: 'id is required' }, { status: 400 });
      }
      const patch = {};
      if (typeof body.title === 'string') {
        const title = body.title.trim();
        patch.title = title || null;
      }
      if (typeof body.query === 'string') {
        const query = body.query.trim();
        if (!query) {
          return Response.json({ success: false, error: 'query must not be empty' }, { status: 400 });
        }
        patch.query = query;
      }
      if (typeof body.showAsSidebarPill === 'boolean') {
        patch.showAsSidebarPill = body.showAsSidebarPill;
      }
      if (typeof body.showInSidebarMenu === 'boolean') {
        patch.showInSidebarMenu = body.showInSidebarMenu;
      }
      if (typeof body.showInSearchDialog === 'boolean') {
        patch.showInSearchDialog = body.showInSearchDialog;
      }
      const existing = (await settings.getSavedSearches()).find((s) => s.id === id);
      if (!existing) {
        return Response.json({ success: false, error: 'Saved search not found' }, { status: 404 });
      }
      const mergedVisibility = {
        showAsSidebarPill: patch.showAsSidebarPill !== undefined ? patch.showAsSidebarPill : existing.showAsSidebarPill,
        showInSidebarMenu: patch.showInSidebarMenu !== undefined ? patch.showInSidebarMenu : existing.showInSidebarMenu,
        showInSearchDialog: patch.showInSearchDialog !== undefined ? patch.showInSearchDialog : existing.showInSearchDialog,
      };
      if (!hasAnySavedSearchVisibility(mergedVisibility)) {
        return Response.json({ success: false, error: 'at least one visibility option is required' }, { status: 400 });
      }
      patch.updatedAt = new Date().toISOString();
      const result = await settings.updateSavedSearch(id, patch);
      return Response.json({ success: true, savedSearch: result });
    } catch (error) {
      if (error.message === 'Malformed JSON') {
        return Response.json({ success: false, error: 'Malformed JSON' }, { status: 400 });
      }
      return Response.json({ success: false, error: error.message }, { status: 500 });
    }
  }

  async function deleteSavedSearch(_request, url) {
    const id = url.searchParams.get('id');
    if (!id) {
      return Response.json({ success: false, error: 'id query parameter is required' }, { status: 400 });
    }
    try {
      const removed = await settings.removeSavedSearch(id);
      if (!removed) {
        return Response.json({ success: false, error: 'Saved search not found' }, { status: 404 });
      }
      return Response.json({ success: true });
    } catch (error) {
      return Response.json({ success: false, error: error.message }, { status: 500 });
    }
  }

  async function putSavedSearchReorder(request) {
    try {
      const body = await parseJsonBody(request);
      const oldOrder = Array.isArray(body.oldOrder) ? body.oldOrder : [];
      const newOrder = Array.isArray(body.newOrder) ? body.newOrder : [];
      const result = await settings.reorderSavedSearches(oldOrder, newOrder);
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

  async function getFolders() {
    try {
      const folders = await settings.getFolders();
      return Response.json({ folders });
    } catch (error) {
      return Response.json({ success: false, error: error.message }, { status: 500 });
    }
  }

  async function postFolder(request) {
    try {
      const body = await parseJsonBody(request);
      const name = String(body.name || '').trim();
      if (!name) {
        return Response.json({ success: false, error: 'name is required' }, { status: 400 });
      }
      const folder = {
        id: crypto.randomUUID(),
        name,
        filter: sanitizeFilter(body.filter),
        createdAt: new Date().toISOString(),
      };
      const result = await settings.addFolder(folder);
      return Response.json({ success: true, folder: result });
    } catch (error) {
      if (error.message === 'Malformed JSON') {
        return Response.json({ success: false, error: 'Malformed JSON' }, { status: 400 });
      }
      return Response.json({ success: false, error: error.message }, { status: 500 });
    }
  }

  async function putFolder(request) {
    try {
      const body = await parseJsonBody(request);
      const folderId = String(body.id || '').trim();
      if (!folderId) {
        return Response.json({ success: false, error: 'id is required' }, { status: 400 });
      }
      const patch = {};
      if (typeof body.name === 'string') {
        const name = body.name.trim();
        if (!name) {
          return Response.json({ success: false, error: 'name is required' }, { status: 400 });
        }
        patch.name = name;
      }
      if (body.filter && typeof body.filter === 'object') patch.filter = sanitizeFilter(body.filter);
      const result = await settings.updateFolder(folderId, patch);
      return Response.json({ success: true, folder: result });
    } catch (error) {
      if (error.message === 'Malformed JSON') {
        return Response.json({ success: false, error: 'Malformed JSON' }, { status: 400 });
      }
      return Response.json({ success: false, error: error.message }, { status: 500 });
    }
  }

  async function deleteFolder(_request, url) {
    const folderId = url.searchParams.get('id');
    if (!folderId) {
      return Response.json({ success: false, error: 'id query parameter is required' }, { status: 400 });
    }
    try {
      const removed = await settings.removeFolder(folderId);
      if (!removed) {
        return Response.json({ success: false, error: 'Folder not found' }, { status: 404 });
      }
      return Response.json({ success: true });
    } catch (error) {
      return Response.json({ success: false, error: error.message }, { status: 500 });
    }
  }

  return {
    '/api/v1/app/session-name': { PUT: putSessionNameHandler },
    '/api/v1/app/settings': { GET: getAppSettings, PUT: putAppSettings },
    '/api/v1/app/telegram/test': { POST: postTelegramTest },
    '/api/v1/app/folders': { GET: getFolders, POST: postFolder, PUT: putFolder, DELETE: deleteFolder },
    '/api/v1/app/saved-searches': { GET: getSavedSearches, POST: postSavedSearch, PUT: putSavedSearch, DELETE: deleteSavedSearch },
    '/api/v1/app/saved-searches/reorder': { PUT: putSavedSearchReorder },
  };
}
