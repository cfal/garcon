import { getProjectBasePath } from '../config.js';
import { resolveGenerationContext } from '../settings/generation-config-source.ts';
import { resolveEffectiveGenerationUiConfig } from '../settings/generation-effective.js';
import { normalizeUiSettings, sanitizeFolderFilter } from '../settings/settings-shared.js';
import { withJsonBody } from '../lib/json-route.js';
import type { RouteMap } from '../lib/http-route-types.js';
import type { SettingsStore } from '../settings/store.js';
import type { AgentRegistryServiceContract } from '../agents/registry.js';
import type { TelegramNotifier } from '../notifications/telegram.js';
import type { TelegramSettingsStore, TelegramPublicStatus } from '../notifications/telegram-settings-store.js';
import type { ChatFolder, SavedChatSearch } from '../settings/types.js';
import { asJsonBody, errorMessage, type JsonBody } from './route-helpers.js';

// Builds the canonical remote settings snapshot used by GET, PUT, and
// WebSocket broadcast paths. Single source of truth for the shape.
const TELEGRAM_LINK_POLL_SECONDS = 20;

const emptyTelegramStatus: TelegramPublicStatus = {
  botTokenAvailable: false,
  botUsername: null,
  botFirstName: null,
  recipientUsername: null,
  recipientDisplayName: null,
  recipientLinked: false,
  pendingLink: false,
  linkUrl: null,
};

function telegramTokenTestFailedResponse(error: unknown): Response {
  return Response.json({
    success: false,
    error: 'Telegram token test failed',
    errorCode: 'telegram_token_test_failed',
    details: error instanceof Error ? error.message : String(error),
  }, { status: 400 });
}

function asPlainObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function resolveCommitMessageUiConfig(
  input: Parameters<typeof resolveEffectiveGenerationUiConfig>[0],
): Omit<ReturnType<typeof resolveEffectiveGenerationUiConfig>, 'enabled'> {
  const config = { ...resolveEffectiveGenerationUiConfig(input) };
  delete (config as { enabled?: boolean }).enabled;
  return config;
}

function workspaceDomainErrorResponse(error: unknown): Response | null {
  const message = errorMessage(error);
  if (/^Saved search with ID .+ already exists$/.test(message)) {
    return Response.json({ success: false, error: message, errorCode: 'SAVED_SEARCH_ALREADY_EXISTS' }, { status: 409 });
  }
  if (message.startsWith('Saved search not found')) {
    return Response.json({ success: false, error: message, errorCode: 'SAVED_SEARCH_NOT_FOUND' }, { status: 404 });
  }
  if (/^Folder with ID .+ already exists$/.test(message)) {
    return Response.json({ success: false, error: message, errorCode: 'FOLDER_ALREADY_EXISTS' }, { status: 409 });
  }
  if (message.startsWith('Folder not found')) {
    return Response.json({ success: false, error: message, errorCode: 'FOLDER_NOT_FOUND' }, { status: 404 });
  }
  return null;
}

export async function buildRemoteSettingsSnapshot({
  settings,
  agents,
  telegramSettings,
}: {
  settings: SettingsStore;
  agents: AgentRegistryServiceContract;
  telegramSettings?: TelegramSettingsStore | null;
}) {
  const settingsSource = settings.getRemoteSettingsSnapshotSource();
  const generationContext = await resolveGenerationContext(agents);

  const version = settingsSource.version;
  const ui = normalizeUiSettings(settingsSource.ui);
  const paths = settingsSource.paths;
  const pinnedChatIds = settingsSource.pinnedChatIds;
  const recentAgentSettings = settingsSource.recentAgentSettings;
  const executionDefaults = settingsSource.executionDefaults;

  const uiEffective = {
    chatTitle: resolveEffectiveGenerationUiConfig({
      persisted: asPlainObject(ui?.chatTitle),
      ...generationContext,
    }),
    commitMessage: resolveCommitMessageUiConfig({
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
        ? paths.pinnedProjectPaths.filter((entry): entry is string => typeof entry === 'string')
        : [],
      browseStartPath: typeof paths?.browseStartPath === 'string' ? paths.browseStartPath : '',
      recentProjectPaths: Array.isArray(paths?.recentProjectPaths)
        ? paths.recentProjectPaths.filter((entry): entry is string => typeof entry === 'string')
        : [],
    },
    pinnedChatIds: Array.isArray(pinnedChatIds) ? pinnedChatIds : [],
    recentAgentSettings,
    executionDefaults,
    projectBasePath: getProjectBasePath(),
    telegram: telegramSettings?.getPublicStatus?.() ?? emptyTelegramStatus,
  };
}

interface SavedSearchInput {
  title: string | null;
  query: string;
  showAsSidebarPill: boolean;
  showInSidebarMenu: boolean;
  showInSearchDialog: boolean;
}

export default function createWorkspaceRoutes(
  settings: SettingsStore,
  agents: AgentRegistryServiceContract,
  telegramNotifier: TelegramNotifier,
  telegramSettings: TelegramSettingsStore,
): RouteMap {

  function sanitizeRemoteUiPatch(raw: unknown): Record<string, unknown> | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const patch = { ...asPlainObject(raw) };
    const notifications = asPlainObject(patch.notifications);
    const rawTelegram = notifications.telegram;
    if (rawTelegram && typeof rawTelegram === 'object' && !Array.isArray(rawTelegram)) {
      const notificationTelegram = asPlainObject(rawTelegram);
      const telegram: Record<string, boolean> = {};
      if (typeof notificationTelegram.enabled === 'boolean') {
        telegram.enabled = notificationTelegram.enabled;
      }
      patch.notifications = Object.keys(telegram).length > 0 ? { telegram } : {};
    }
    return Object.keys(patch).length > 0 ? patch : null;
  }

  async function putSessionNameHandler(body: JsonBody): Promise<Response> {
    try {
      const { chatId, title } = asJsonBody(body);
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
      return Response.json({ success: false, error: errorMessage(error) }, { status: 500 });
    }
  }

  async function getAppSettings(): Promise<Response> {
    try {
      const snapshot = await buildRemoteSettingsSnapshot({ settings, agents, telegramSettings });
      return Response.json(snapshot);
    } catch (error) {
      return Response.json({ success: false, error: errorMessage(error) }, { status: 500 });
    }
  }

  async function putAppSettings(body: JsonBody): Promise<Response> {
    try {
      const input = asJsonBody(body);
      const uiPatch = sanitizeRemoteUiPatch(input.ui);
      if (uiPatch) {
        await settings.setUiSettings(uiPatch);
      }

      if (input.paths && typeof input.paths === 'object' && !Array.isArray(input.paths)) {
        await settings.setPathSettings(input.paths as Record<string, unknown>);
      }

      const snapshot = await buildRemoteSettingsSnapshot({ settings, agents, telegramSettings });
      return Response.json({ success: true, settings: snapshot });
    } catch (error) {
      return Response.json({ success: false, error: errorMessage(error) }, { status: 500 });
    }
  }

  async function postTelegramTest(_request: Request): Promise<Response> {
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
      const message = errorMessage(error);
      const status = message.startsWith('Telegram ') || message.includes('bot token') ? 400 : 500;
      return Response.json({ success: false, error: message }, { status });
    }
  }

  async function putTelegramToken(body: JsonBody): Promise<Response> {
    try {
      if (!telegramSettings) {
        return Response.json({ success: false, error: 'Telegram settings store is not configured' }, { status: 500 });
      }
      const input = asJsonBody(body);
      const botToken = typeof input.botToken === 'string' ? input.botToken.trim() : '';
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
      return Response.json({ success: false, error: errorMessage(error) }, { status: 500 });
    }
  }

  async function deleteTelegramToken(): Promise<Response> {
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
      return Response.json({ success: false, error: errorMessage(error) }, { status: 500 });
    }
  }

  async function postTelegramTokenTest(body: JsonBody): Promise<Response> {
    try {
      if (!telegramSettings) {
        return Response.json({ success: false, error: 'Telegram settings store is not configured' }, { status: 500 });
      }
      const input = asJsonBody(body);
      const botToken = typeof input.botToken === 'string' ? input.botToken.trim() : '';
      const tokenToTest = botToken || telegramSettings.getBotToken();
      const identity = await telegramNotifier.getBotIdentity(tokenToTest);
      return Response.json({ success: true, bot: identity });
    } catch (error) {
      return telegramTokenTestFailedResponse(error);
    }
  }

  async function postTelegramRecipientLink(): Promise<Response> {
    try {
      if (!telegramSettings) {
        return Response.json({ success: false, error: 'Telegram settings store is not configured' }, { status: 500 });
      }
      const linkUrl = await telegramSettings.beginRecipientLink();
      const snapshot = await buildRemoteSettingsSnapshot({ settings, agents, telegramSettings });
      return Response.json({ success: true, linkUrl, settings: snapshot });
    } catch (error) {
      return Response.json({ success: false, error: errorMessage(error) }, { status: 400 });
    }
  }

  async function postTelegramRecipientResolve(): Promise<Response> {
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
      return Response.json({ success: false, error: errorMessage(error) }, { status: 400 });
    }
  }

  async function deleteTelegramRecipient(): Promise<Response> {
    try {
      if (!telegramSettings) {
        return Response.json({ success: false, error: 'Telegram settings store is not configured' }, { status: 500 });
      }
      await telegramSettings.clearRecipient();
      const snapshot = await buildRemoteSettingsSnapshot({ settings, agents, telegramSettings });
      return Response.json({ success: true, settings: snapshot });
    } catch (error) {
      return Response.json({ success: false, error: errorMessage(error) }, { status: 500 });
    }
  }

  function sanitizeSavedSearchInput(raw: unknown): SavedSearchInput | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const source = asPlainObject(raw);
    const titleRaw = typeof source.title === 'string' ? source.title.trim() : '';
    const query = typeof source.query === 'string' ? source.query.trim() : '';
    const showAsSidebarPill = source.showAsSidebarPill === true;
    const showInSidebarMenu = source.showInSidebarMenu === true;
    const showInSearchDialog = source.showInSearchDialog === true;
    return { title: titleRaw || null, query, showAsSidebarPill, showInSidebarMenu, showInSearchDialog };
  }

  function hasAnySavedSearchVisibility(input: Pick<SavedSearchInput, 'showAsSidebarPill' | 'showInSidebarMenu' | 'showInSearchDialog'>): boolean {
    return input.showAsSidebarPill || input.showInSidebarMenu || input.showInSearchDialog;
  }

  async function getSavedSearches(): Promise<Response> {
    try {
      const savedSearches = await settings.getSavedSearches();
      return Response.json({ savedSearches });
    } catch (error) {
      return Response.json({ success: false, error: errorMessage(error) }, { status: 500 });
    }
  }

  async function postSavedSearch(body: JsonBody): Promise<Response> {
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
      const domainError = workspaceDomainErrorResponse(error);
      if (domainError) return domainError;
      return Response.json({ success: false, error: errorMessage(error) }, { status: 500 });
    }
  }

  async function putSavedSearch(body: JsonBody): Promise<Response> {
    try {
      const input = asJsonBody(body);
      const id = String(input.id || '').trim();
      if (!id) {
        return Response.json({ success: false, error: 'id is required' }, { status: 400 });
      }
      const patch: Partial<SavedChatSearch> = {};
      if (typeof input.title === 'string') {
        const title = input.title.trim();
        patch.title = title || null;
      }
      if (typeof input.query === 'string') {
        const query = input.query.trim();
        if (!query) {
          return Response.json({ success: false, error: 'query must not be empty' }, { status: 400 });
        }
        patch.query = query;
      }
      if (typeof input.showAsSidebarPill === 'boolean') {
        patch.showAsSidebarPill = input.showAsSidebarPill;
      }
      if (typeof input.showInSidebarMenu === 'boolean') {
        patch.showInSidebarMenu = input.showInSidebarMenu;
      }
      if (typeof input.showInSearchDialog === 'boolean') {
        patch.showInSearchDialog = input.showInSearchDialog;
      }
      const existing = (await settings.getSavedSearches()).find((s) => s.id === id);
      if (!existing) {
        return Response.json({ success: false, error: 'Saved search not found', errorCode: 'SAVED_SEARCH_NOT_FOUND' }, { status: 404 });
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
      const domainError = workspaceDomainErrorResponse(error);
      if (domainError) return domainError;
      return Response.json({ success: false, error: errorMessage(error) }, { status: 500 });
    }
  }

  async function deleteSavedSearch(_request: Request, url: URL): Promise<Response> {
    const id = url.searchParams.get('id');
    if (!id) {
      return Response.json({ success: false, error: 'id query parameter is required' }, { status: 400 });
    }
    try {
      const removed = await settings.removeSavedSearch(id);
      if (!removed) {
        return Response.json({ success: false, error: 'Saved search not found', errorCode: 'SAVED_SEARCH_NOT_FOUND' }, { status: 404 });
      }
      return Response.json({ success: true });
    } catch (error) {
      return Response.json({ success: false, error: errorMessage(error) }, { status: 500 });
    }
  }

  async function putSavedSearchReorder(body: JsonBody): Promise<Response> {
    try {
      const oldOrder = Array.isArray(body.oldOrder) ? body.oldOrder : [];
      const newOrder = Array.isArray(body.newOrder) ? body.newOrder : [];
      const result = await settings.reorderSavedSearches(oldOrder, newOrder);
      if (!result.success) {
        return Response.json({ success: false, error: result.error }, { status: 400 });
      }
      return Response.json({ success: true });
    } catch (error) {
      return Response.json({ success: false, error: errorMessage(error) }, { status: 500 });
    }
  }

  async function getFolders(): Promise<Response> {
    try {
      const folders = await settings.getFolders();
      return Response.json({ folders });
    } catch (error) {
      return Response.json({ success: false, error: errorMessage(error) }, { status: 500 });
    }
  }

  async function postFolder(body: JsonBody): Promise<Response> {
    try {
      const input = asJsonBody(body);
      const name = String(input.name || '').trim();
      if (!name) {
        return Response.json({ success: false, error: 'name is required' }, { status: 400 });
      }
      const folder = {
        id: crypto.randomUUID(),
        name,
        filter: sanitizeFolderFilter(input.filter),
        createdAt: new Date().toISOString(),
      };
      const result = await settings.addFolder(folder);
      return Response.json({ success: true, folder: result });
    } catch (error) {
      const domainError = workspaceDomainErrorResponse(error);
      if (domainError) return domainError;
      return Response.json({ success: false, error: errorMessage(error) }, { status: 500 });
    }
  }

  async function putFolder(body: JsonBody): Promise<Response> {
    try {
      const input = asJsonBody(body);
      const folderId = String(input.id || '').trim();
      if (!folderId) {
        return Response.json({ success: false, error: 'id is required' }, { status: 400 });
      }
      const patch: Partial<ChatFolder> = {};
      if (typeof input.name === 'string') {
        const name = input.name.trim();
        if (!name) {
          return Response.json({ success: false, error: 'name is required' }, { status: 400 });
        }
        patch.name = name;
      }
      if (input.filter && typeof input.filter === 'object') patch.filter = sanitizeFolderFilter(input.filter);
      const result = await settings.updateFolder(folderId, patch);
      return Response.json({ success: true, folder: result });
    } catch (error) {
      const domainError = workspaceDomainErrorResponse(error);
      if (domainError) return domainError;
      return Response.json({ success: false, error: errorMessage(error) }, { status: 500 });
    }
  }

  async function deleteFolder(_request: Request, url: URL): Promise<Response> {
    const folderId = url.searchParams.get('id');
    if (!folderId) {
      return Response.json({ success: false, error: 'id query parameter is required' }, { status: 400 });
    }
    try {
      const removed = await settings.removeFolder(folderId);
      if (!removed) {
        return Response.json({ success: false, error: 'Folder not found', errorCode: 'FOLDER_NOT_FOUND' }, { status: 404 });
      }
      return Response.json({ success: true });
    } catch (error) {
      return Response.json({ success: false, error: errorMessage(error) }, { status: 500 });
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
