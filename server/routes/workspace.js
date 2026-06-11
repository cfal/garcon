import { getProjectBasePath } from '../config.js';
import { resolveGenerationContext } from '../settings/generation-config-source.ts';
import { resolveEffectiveGenerationUiConfig } from '../settings/generation-effective.js';
import { withJsonBody } from '../lib/json-route.js';

// Builds the canonical remote settings snapshot used by GET, PUT, and
// WebSocket broadcast paths. Single source of truth for the shape.
const TELEGRAM_LINK_POLL_SECONDS = 20;

const emptyTelegramStatus = {
  botTokenAvailable: false,
  botUsername: null,
  botFirstName: null,
  recipientUsername: null,
  recipientDisplayName: null,
  recipientLinked: false,
  pendingLink: false,
  linkUrl: null,
};

function telegramTokenTestFailedResponse(error) {
  return Response.json({
    success: false,
    error: 'Telegram token test failed',
    errorCode: 'telegram_token_test_failed',
    details: error instanceof Error ? error.message : String(error),
  }, { status: 400 });
}

function asPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export async function buildRemoteSettingsSnapshot({ settings, agents, telegramSettings }) {
  const settingsSource = await settings.getRemoteSettingsSnapshotSource();
  const generationContext = await resolveGenerationContext(agents);

  const [
    version, ui, paths, pinnedChatIds, lastAgentId, lastProjectPath, lastModel,
    lastPermissionMode, lastThinkingMode, lastClaudeThinkingMode, lastAmpAgentMode,
    lastApiProviderId, lastModelEndpointId, lastModelProtocol,
  ] = settingsSource
    ? [
      settingsSource.version,
      asPlainObject(settingsSource.ui),
      settingsSource.paths,
      settingsSource.pinnedChatIds,
      settingsSource.lastAgentId,
      settingsSource.lastProjectPath,
      settingsSource.lastModel,
      settingsSource.lastPermissionMode,
      settingsSource.lastThinkingMode,
      settingsSource.lastClaudeThinkingMode,
      settingsSource.lastAmpAgentMode,
      settingsSource.lastApiProviderId ?? null,
      settingsSource.lastModelEndpointId ?? null,
      settingsSource.lastModelProtocol ?? null,
    ]
    : await Promise.all([
      settings.getRemoteSettingsVersion(),
      settings.getUiSettings(),
      settings.getPathSettings(),
      settings.getPinnedChatIds(),
      settings.getLastAgentId(),
      settings.getLastProjectPath(),
      settings.getLastModel(),
      settings.getLastPermissionMode(),
      settings.getLastThinkingMode(),
      settings.getLastClaudeThinkingMode(),
      settings.getLastAmpAgentMode(),
      settings.getLastApiProviderId(),
      settings.getLastModelEndpointId(),
      settings.getLastModelProtocol(),
    ]);

  const uiEffective = {
    chatTitle: resolveEffectiveGenerationUiConfig({
      persisted: asPlainObject(ui?.chatTitle),
      ...generationContext,
    }),
    commitMessage: resolveEffectiveGenerationUiConfig({
      persisted: asPlainObject(ui?.commitMessage),
      ...generationContext,
    }),
  };

  return {
    version,
    ui: asPlainObject(ui),
    uiEffective,
    paths: {
      pinnedProjectPaths: Array.isArray(paths?.pinnedProjectPaths)
        ? paths.pinnedProjectPaths.filter((entry) => typeof entry === 'string')
        : [],
      browseStartPath: typeof paths?.browseStartPath === 'string' ? paths.browseStartPath : '',
    },
    pinnedChatIds: Array.isArray(pinnedChatIds) ? pinnedChatIds : [],
    lastAgentId,
    lastProjectPath,
    lastModel,
    lastApiProviderId: lastApiProviderId ?? null,
    lastModelEndpointId: lastModelEndpointId ?? null,
    lastModelProtocol: lastModelProtocol ?? null,
    lastPermissionMode,
    lastThinkingMode,
    lastClaudeThinkingMode,
    lastAmpAgentMode,
    projectBasePath: getProjectBasePath(),
    telegram: telegramSettings?.getPublicStatus?.() ?? emptyTelegramStatus,
  };
}

export default function createWorkspaceRoutes(settings, agents, telegramNotifier, telegramSettings) {

  const FILTER_KEYS = ['textTokens', 'tags', 'agents', 'models'];
  const VALID_FILTER_STATUS = new Set(['active', 'unread']);
  function sanitizeRemoteUiPatch(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const patch = { ...raw };
    const notifications = asPlainObject(patch.notifications);
    if (notifications.telegram && typeof notifications.telegram === 'object' && !Array.isArray(notifications.telegram)) {
      const telegram = {};
      if (typeof notifications.telegram.enabled === 'boolean') {
        telegram.enabled = notifications.telegram.enabled;
      }
      patch.notifications = Object.keys(telegram).length > 0 ? { telegram } : {};
    }
    return Object.keys(patch).length > 0 ? patch : null;
  }
	function sanitizeFilter(raw) {
    const empty = { textTokens: [], tags: [], agents: [], models: [] };
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

  async function putSessionNameHandler(body) {
    try {
      const { chatId, title } = body;
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
      const snapshot = await buildRemoteSettingsSnapshot({ settings, agents, telegramSettings });
      return Response.json(snapshot);
    } catch (error) {
      return Response.json({ success: false, error: error.message }, { status: 500 });
    }
  }

  async function putAppSettings(body) {
    try {
      const uiPatch = sanitizeRemoteUiPatch(body.ui);
      if (uiPatch) {
        await settings.setUiSettings(uiPatch);
      }

      if (body.paths && typeof body.paths === 'object') {
        await settings.setPathSettings(body.paths);
      }

      const snapshot = await buildRemoteSettingsSnapshot({ settings, agents, telegramSettings });
      return Response.json({ success: true, settings: snapshot });
    } catch (error) {
      return Response.json({ success: false, error: error.message }, { status: 500 });
    }
  }

  async function postTelegramTest(request) {
    try {
      if (!telegramNotifier?.isConfigured) {
        return Response.json({ success: false, error: 'Telegram bot token is not configured' }, { status: 400 });
      }
      const chatId = telegramSettings?.getRecipientChatId?.() ?? '';
      if (!chatId) {
        return Response.json({ success: false, error: 'Telegram recipient is not linked' }, { status: 400 });
      }
      const ok = await telegramNotifier.send(chatId, 'Garcon: test notification. Your Telegram integration is working.');
      if (!ok) {
        return Response.json({ success: false, error: 'Telegram delivery failed. Check your bot token and linked recipient.' }, { status: 502 });
      }
      return Response.json({ success: true });
    } catch (error) {
      const status = error.message.startsWith('Telegram ') || error.message.includes('bot token') ? 400 : 500;
      return Response.json({ success: false, error: error.message }, { status });
    }
  }

  async function putTelegramToken(body) {
    try {
      if (!telegramSettings) {
        return Response.json({ success: false, error: 'Telegram settings store is not configured' }, { status: 500 });
      }
      const botToken = typeof body.botToken === 'string' ? body.botToken.trim() : '';
      if (!botToken) {
        return Response.json({
          success: false,
          error: 'botToken is required',
          errorCode: 'telegram_bot_token_required',
        }, { status: 400 });
      }
      let identity;
      try {
        identity = await telegramNotifier.getBotIdentity(botToken);
      } catch (error) {
        return telegramTokenTestFailedResponse(error);
      }
      await telegramSettings.setBotToken(botToken, identity);
      telegramNotifier?.setBotToken?.(botToken);
      await telegramSettings.beginRecipientLink();
      const snapshot = await buildRemoteSettingsSnapshot({ settings, agents, telegramSettings });
      return Response.json({ success: true, settings: snapshot });
    } catch (error) {
      return Response.json({ success: false, error: error.message }, { status: 500 });
    }
  }

  async function deleteTelegramToken() {
    try {
      if (!telegramSettings) {
        return Response.json({ success: false, error: 'Telegram settings store is not configured' }, { status: 500 });
      }
      await telegramSettings.clearBotToken();
      telegramNotifier?.setBotToken?.('');
      await settings.setUiSettings({ notifications: { telegram: { enabled: false } } });
      const snapshot = await buildRemoteSettingsSnapshot({ settings, agents, telegramSettings });
      return Response.json({ success: true, settings: snapshot });
    } catch (error) {
      return Response.json({ success: false, error: error.message }, { status: 500 });
    }
  }

  async function postTelegramTokenTest(body) {
    try {
      if (!telegramSettings) {
        return Response.json({ success: false, error: 'Telegram settings store is not configured' }, { status: 500 });
      }
      const botToken = typeof body.botToken === 'string' ? body.botToken.trim() : '';
      const tokenToTest = botToken || telegramSettings.getBotToken();
      const identity = await telegramNotifier.getBotIdentity(tokenToTest);
      return Response.json({ success: true, bot: identity });
    } catch (error) {
      return telegramTokenTestFailedResponse(error);
    }
  }

  async function postTelegramRecipientLink() {
    try {
      if (!telegramSettings) {
        return Response.json({ success: false, error: 'Telegram settings store is not configured' }, { status: 500 });
      }
      const linkUrl = await telegramSettings.beginRecipientLink();
      const snapshot = await buildRemoteSettingsSnapshot({ settings, agents, telegramSettings });
      return Response.json({ success: true, linkUrl, settings: snapshot });
    } catch (error) {
      return Response.json({ success: false, error: error.message }, { status: 400 });
    }
  }

  async function postTelegramRecipientResolve() {
    try {
      if (!telegramSettings) {
        return Response.json({ success: false, error: 'Telegram settings store is not configured' }, { status: 500 });
      }
      const linkCode = telegramSettings.getPendingLinkCode();
      const offset = telegramSettings.getUpdateOffset();
      const result = await telegramNotifier.resolveRecipientLink(
        linkCode,
        offset,
        TELEGRAM_LINK_POLL_SECONDS,
      );
      if (result.nextOffset !== offset) {
        await telegramSettings.setUpdateOffset(result.nextOffset);
      }
      if (!result.recipient) {
        const snapshot = await buildRemoteSettingsSnapshot({ settings, agents, telegramSettings });
        return Response.json({ success: false, error: 'No matching Telegram /start message found yet', settings: snapshot });
      }
      await telegramSettings.completeRecipientLink(result.recipient);
      const snapshot = await buildRemoteSettingsSnapshot({ settings, agents, telegramSettings });
      return Response.json({ success: true, settings: snapshot });
    } catch (error) {
      return Response.json({ success: false, error: error.message }, { status: 400 });
    }
  }

  async function deleteTelegramRecipient() {
    try {
      if (!telegramSettings) {
        return Response.json({ success: false, error: 'Telegram settings store is not configured' }, { status: 500 });
      }
      await telegramSettings.clearRecipient();
      const snapshot = await buildRemoteSettingsSnapshot({ settings, agents, telegramSettings });
      return Response.json({ success: true, settings: snapshot });
    } catch (error) {
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

  async function postSavedSearch(body) {
    try {
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
      return Response.json({ success: false, error: error.message }, { status: 500 });
    }
  }

  async function putSavedSearch(body) {
    try {
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

  async function putSavedSearchReorder(body) {
    try {
      const oldOrder = Array.isArray(body.oldOrder) ? body.oldOrder : [];
      const newOrder = Array.isArray(body.newOrder) ? body.newOrder : [];
      const result = await settings.reorderSavedSearches(oldOrder, newOrder);
      if (!result.success) {
        return Response.json({ success: false, error: result.error }, { status: 400 });
      }
      return Response.json({ success: true });
    } catch (error) {
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

  async function postFolder(body) {
    try {
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
      return Response.json({ success: false, error: error.message }, { status: 500 });
    }
  }

  async function putFolder(body) {
    try {
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
    '/api/v1/app/session-name': { PUT: withJsonBody(putSessionNameHandler) },
    '/api/v1/app/settings': { GET: getAppSettings, PUT: withJsonBody(putAppSettings) },
    '/api/v1/app/telegram/test': { POST: postTelegramTest },
    '/api/v1/app/telegram/token/test': { POST: withJsonBody(postTelegramTokenTest) },
    '/api/v1/app/telegram/token': { PUT: withJsonBody(putTelegramToken), DELETE: deleteTelegramToken },
    '/api/v1/app/telegram/recipient/link': { POST: postTelegramRecipientLink },
    '/api/v1/app/telegram/recipient/resolve': { POST: postTelegramRecipientResolve },
    '/api/v1/app/telegram/recipient': { DELETE: deleteTelegramRecipient },
    '/api/v1/app/folders': { GET: getFolders, POST: withJsonBody(postFolder), PUT: withJsonBody(putFolder), DELETE: deleteFolder },
    '/api/v1/app/saved-searches': { GET: getSavedSearches, POST: withJsonBody(postSavedSearch), PUT: withJsonBody(putSavedSearch), DELETE: deleteSavedSearch },
    '/api/v1/app/saved-searches/reorder': { PUT: withJsonBody(putSavedSearchReorder) },
  };
}
