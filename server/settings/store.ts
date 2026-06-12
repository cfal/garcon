// App settings persistence (project-settings.json). Manages ui preferences,
// path settings, chat-scoped session name overrides, and ordering lists.
// Normal reads and mutations use the initialized in-memory cache. loadSettings()
// is the explicit external-change recovery path and refreshes that cache.

import { promises as fs } from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { writeJsonFileAtomic } from '../lib/json-file-store.ts';
import { KeyedPromiseLock } from '../lib/keyed-lock.ts';
import {
  ChatNameStore,
  ChatOrderStore,
  FolderStore,
  LastChatDefaultsStore,
  SavedSearchStore,
  UiSettingsStore,
} from './domain-stores.js';
import {
  normalizeRemoteSettingsVersion,
  normalizeUiSettings,
  sanitizeFolderFilter,
  sanitizeStringArray,
} from './settings-shared.js';
import {
  DEFAULT_AMP_AGENT_MODE,
  DEFAULT_CLAUDE_THINKING_MODE,
  DEFAULT_PERMISSION_MODE,
  DEFAULT_THINKING_MODE,
  normalizeAmpAgentMode,
  normalizeClaudeThinkingMode,
  normalizePermissionMode,
  normalizeThinkingMode,
  type AmpAgentMode,
  type ClaudeThinkingMode,
  type PermissionMode,
  type ThinkingMode,
} from '../../common/chat-modes.ts';
import type { ApiProtocol } from '../../common/api-providers.js';
import type { IChatRegistry } from '../chats/store.js';
import { createLogger } from '../lib/log.js';
import { errorMessage, hasNodeErrorCode } from '../lib/errors.js';

const logger = createLogger('settings:store');
import type {
  ChatFolder,
  ProjectSettings,
  ReorderResult,
  SavedChatSearch,
  SettingsMutation,
  SettingsStoreContext,
} from './types.js';

const SETTINGS_WRITE_LOCK_KEY = 'project-settings';

type SessionNameChangedCallback = (chatId: string, title: string) => void;
type ListChangedCallback = (reason: string, chatId: string) => void;
type RemoteSettingsChangedCallback = () => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringRecord(raw: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') result[key] = value;
  }
  return result;
}

function createEmpty(): ProjectSettings {
  return {
    ui: {},
    paths: {},
    chatNames: {},
    remoteSettingsVersion: 0,
    pinnedChatIds: [],
    normalChatIds: [],
    archivedChatIds: [],
    lastAgentId: 'claude',
    lastProjectPath: '',
    lastModel: '',
    lastApiProviderId: null,
    lastModelEndpointId: null,
    lastModelProtocol: null,
    lastPermissionMode: DEFAULT_PERMISSION_MODE,
    lastThinkingMode: DEFAULT_THINKING_MODE,
    lastClaudeThinkingMode: DEFAULT_CLAUDE_THINKING_MODE,
    lastAmpAgentMode: DEFAULT_AMP_AGENT_MODE,
    chatFolders: [],
    savedChatSearches: [],
  };
}

function sanitizeFolder(raw: unknown): ChatFolder | null {
  if (!isRecord(raw)) return null;

  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  const createdAt = typeof raw.createdAt === 'string' ? raw.createdAt.trim() : '';
  if (!id || !name || !createdAt) return null;

  return {
    id,
    name,
    filter: sanitizeFolderFilter(raw.filter),
    createdAt,
  };
}

function sanitizeSavedSearch(raw: unknown): SavedChatSearch | null {
  if (!isRecord(raw)) return null;

  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const titleRaw = typeof raw.title === 'string' ? raw.title.trim() : '';
  const query = typeof raw.query === 'string' ? raw.query.trim() : '';
  const createdAt = typeof raw.createdAt === 'string' ? raw.createdAt.trim() : '';
  const updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt.trim() : '';
  const showAsSidebarPill = raw.showAsSidebarPill === true;
  const showInSidebarMenu = raw.showInSidebarMenu === true;
  const showInSearchDialog = raw.showInSearchDialog === true;

  if (!id || !query || !createdAt || !updatedAt) return null;
  if (!showAsSidebarPill && !showInSidebarMenu && !showInSearchDialog) return null;

  return {
    id,
    title: titleRaw || null,
    query,
    showAsSidebarPill,
    showInSidebarMenu,
    showInSearchDialog,
    createdAt,
    updatedAt,
  };
}

function sanitize(parsed: unknown): ProjectSettings {
  const raw = isRecord(parsed) ? parsed : {};
  const chatFolders = Array.isArray(raw.chatFolders)
    ? raw.chatFolders.map(sanitizeFolder).filter((folder): folder is ChatFolder => Boolean(folder))
    : [];

  const savedChatSearches = Array.isArray(raw.savedChatSearches)
    ? raw.savedChatSearches.map(sanitizeSavedSearch).filter((search): search is SavedChatSearch => Boolean(search))
    : [];

  return {
    ui: normalizeUiSettings(raw.ui),
    paths: isRecord(raw.paths) ? raw.paths : {},
    chatNames: isRecord(raw.chatNames) ? stringRecord(raw.chatNames) : {},
    remoteSettingsVersion: normalizeRemoteSettingsVersion(raw.remoteSettingsVersion),
    pinnedChatIds: sanitizeStringArray(raw.pinnedChatIds),
    normalChatIds: sanitizeStringArray(raw.normalChatIds),
    archivedChatIds: sanitizeStringArray(raw.archivedChatIds),
    lastAgentId: typeof raw.lastAgentId === 'string' ? raw.lastAgentId : 'claude',
    lastProjectPath: typeof raw.lastProjectPath === 'string' ? raw.lastProjectPath : '',
    lastModel: typeof raw.lastModel === 'string' ? raw.lastModel : '',
    lastApiProviderId: typeof raw.lastApiProviderId === 'string' ? raw.lastApiProviderId : null,
    lastModelEndpointId: typeof raw.lastModelEndpointId === 'string' ? raw.lastModelEndpointId : null,
    lastModelProtocol: (raw.lastModelProtocol === 'openai-compatible' || raw.lastModelProtocol === 'anthropic-messages')
      ? raw.lastModelProtocol
      : null,
    lastPermissionMode: normalizePermissionMode(raw.lastPermissionMode),
    lastThinkingMode: normalizeThinkingMode(raw.lastThinkingMode),
    lastClaudeThinkingMode: normalizeClaudeThinkingMode(raw.lastClaudeThinkingMode),
    lastAmpAgentMode: normalizeAmpAgentMode(raw.lastAmpAgentMode),
    chatFolders,
    savedChatSearches,
  };
}

export class SettingsStore extends EventEmitter {
  #cache: ProjectSettings | null = null;
  #workspaceDir: string;
  #writeLock = new KeyedPromiseLock();
  #chatNames: ChatNameStore;
  #uiSettings: UiSettingsStore;
  #lastChatDefaults: LastChatDefaultsStore;
  #chatOrder: ChatOrderStore;
  #savedSearches: SavedSearchStore;
  #folders: FolderStore;

  constructor(workspaceDir: string) {
    super();
    this.#workspaceDir = workspaceDir;
    const context: SettingsStoreContext = {
      readSettings: () => this.#getCachedSettings(),
      mutate: (fn) => this.#withLock(fn),
      save: (settings) => this.saveSettings(settings),
      saveAndMaybeEmitRemote: (settings, remoteSettingsChanged) => (
        this.#saveSettingsAndMaybeEmitRemote(settings, remoteSettingsChanged)
      ),
      emitSessionNameChanged: (chatId, title) => this.emitSessionNameChanged(chatId, title),
      emitListChanged: (reason, chatId) => this.emitListChanged(reason, chatId),
    };
    this.#chatNames = new ChatNameStore(context);
    this.#uiSettings = new UiSettingsStore(context);
    this.#lastChatDefaults = new LastChatDefaultsStore(context);
    this.#chatOrder = new ChatOrderStore(context);
    this.#savedSearches = new SavedSearchStore(context);
    this.#folders = new FolderStore(context);
  }

  // Serializes read-modify-write cycles so concurrent mutations cannot
  // clobber each other's changes to project-settings.json.
  async #withLock<T>(fn: SettingsMutation<T>): Promise<T> {
    return this.#writeLock.runExclusive(SETTINGS_WRITE_LOCK_KEY, () => Promise.resolve(fn()));
  }

  emitSessionNameChanged(chatId: string, title: string): void { this.emit('session-name-changed', chatId, title); }
  onSessionNameChanged(cb: SessionNameChangedCallback): void { this.on('session-name-changed', cb); }
  emitListChanged(reason: string, chatId: string): void { this.emit('list-changed', reason, chatId); }
  onListChanged(cb: ListChangedCallback): void { this.on('list-changed', cb); }
  emitRemoteSettingsChanged(): void { this.emit('remote-settings-changed'); }
  onRemoteSettingsChanged(cb: RemoteSettingsChangedCallback): void { this.on('remote-settings-changed', cb); }

  #settingsPath(): string {
    return path.join(this.#workspaceDir, 'project-settings.json');
  }

  async #writeToDisk(settings: ProjectSettings): Promise<void> {
    await writeJsonFileAtomic(this.#settingsPath(), settings);
  }

  async #readFromDisk(): Promise<ProjectSettings> {
    try {
      const raw = await fs.readFile(this.#settingsPath(), 'utf8');
      const parsed = JSON.parse(raw);
      return sanitize(parsed);
    } catch (error) {
      if (hasNodeErrorCode(error, 'ENOENT')) return createEmpty();
      logger.warn('settings: invalid project-settings.json, using empty settings:', errorMessage(error));
      return createEmpty();
    }
  }

  async init(): Promise<ProjectSettings> {
    await fs.mkdir(this.#workspaceDir, { recursive: true });
    this.#cache = await this.#readFromDisk();
    return this.#cache;
  }

  async loadSettings(): Promise<ProjectSettings> {
    const newCache = await this.#readFromDisk();
    this.#cache = newCache;
    return newCache;
  }

  #getCachedSettings(): ProjectSettings {
    if (!this.#cache) {
      this.#cache = createEmpty();
    }
    return this.#cache;
  }

  async saveSettings(settings: unknown): Promise<void> {
    const validated = sanitize(settings);
    await this.#writeToDisk(validated);
    this.#cache = validated;
  }

  async #saveSettingsAndMaybeEmitRemote(settings: ProjectSettings, remoteSettingsChanged: boolean): Promise<void> {
    await this.saveSettings(settings);
    if (remoteSettingsChanged) {
      this.emitRemoteSettingsChanged();
    }
  }

  async reconcileWithRegistry(registry: IChatRegistry): Promise<void> {
    return this.#chatOrder.reconcileWithRegistry(registry);
  }

  getChatName(chatId: string): string | null {
    return this.#chatNames.getChatName(chatId);
  }

  async setSessionName(chatId: string, title: string): Promise<void> {
    return this.#chatNames.setSessionName(chatId, title);
  }

  async removeSessionName(chatId: string): Promise<void> {
    return this.#chatNames.removeSessionName(chatId);
  }

  async getUiSettings(): Promise<ProjectSettings['ui']> {
    return this.#uiSettings.getUiSettings();
  }

  async setUiSettings(patch: Record<string, unknown>): Promise<ProjectSettings['ui']> {
    return this.#uiSettings.setUiSettings(patch);
  }

  async getPathSettings(): Promise<ProjectSettings['paths']> {
    return this.#uiSettings.getPathSettings();
  }

  async setPathSettings(patch: Record<string, unknown>): Promise<ProjectSettings['paths']> {
    return this.#uiSettings.setPathSettings(patch);
  }

  async getPinnedChatIds(): Promise<string[]> {
    return this.#chatOrder.getPinnedChatIds();
  }

  async getRemoteSettingsVersion(): Promise<number> {
    return this.#uiSettings.getRemoteSettingsVersion();
  }

  async getRemoteSettingsSnapshotSource(): Promise<{
    version: number;
    ui: ProjectSettings['ui'];
    paths: ProjectSettings['paths'];
    pinnedChatIds: string[];
    lastAgentId: string;
    lastProjectPath: string;
    lastModel: string;
    lastApiProviderId: string | null;
    lastModelEndpointId: string | null;
    lastModelProtocol: ApiProtocol | null;
    lastPermissionMode: PermissionMode;
    lastThinkingMode: ThinkingMode;
    lastClaudeThinkingMode: ClaudeThinkingMode;
    lastAmpAgentMode: AmpAgentMode;
  }> {
    return this.#uiSettings.getRemoteSettingsSnapshotSource();
  }

  async getArchivedChatIds(): Promise<string[]> {
    return this.#chatOrder.getArchivedChatIds();
  }

  async getLastPermissionMode(): Promise<PermissionMode> {
    return this.#lastChatDefaults.getLastPermissionMode();
  }

  async getLastAgentId(): Promise<string> {
    return this.#lastChatDefaults.getLastAgentId();
  }

  async getLastProjectPath(): Promise<string> {
    return this.#lastChatDefaults.getLastProjectPath();
  }

  async getLastModel(): Promise<string> {
    return this.#lastChatDefaults.getLastModel();
  }

  async getLastApiProviderId(): Promise<string | null> {
    return this.#lastChatDefaults.getLastApiProviderId();
  }

  async getLastModelEndpointId(): Promise<string | null> {
    return this.#lastChatDefaults.getLastModelEndpointId();
  }

  async getLastModelProtocol(): Promise<ApiProtocol | null> {
    return this.#lastChatDefaults.getLastModelProtocol();
  }

  async setLastChatDefaults(defaults: Record<string, unknown> | null | undefined): Promise<void> {
    return this.#lastChatDefaults.setLastChatDefaults(defaults);
  }

  async setLastPermissionMode(mode: unknown): Promise<void> {
    return this.#lastChatDefaults.setLastPermissionMode(mode);
  }

  async getLastThinkingMode(): Promise<ThinkingMode> {
    return this.#lastChatDefaults.getLastThinkingMode();
  }

  async setLastThinkingMode(mode: unknown): Promise<void> {
    return this.#lastChatDefaults.setLastThinkingMode(mode);
  }

  async getLastClaudeThinkingMode(): Promise<ClaudeThinkingMode> {
    return this.#lastChatDefaults.getLastClaudeThinkingMode();
  }

  async setLastClaudeThinkingMode(mode: unknown): Promise<void> {
    return this.#lastChatDefaults.setLastClaudeThinkingMode(mode);
  }

  async getLastAmpAgentMode(): Promise<AmpAgentMode> {
    return this.#lastChatDefaults.getLastAmpAgentMode();
  }

  async setLastAmpAgentMode(mode: unknown): Promise<void> {
    return this.#lastChatDefaults.setLastAmpAgentMode(mode);
  }

  async getNormalChatIds(): Promise<string[]> {
    return this.#chatOrder.getNormalChatIds();
  }

  async ensureInNormal(chatId: string): Promise<void> {
    return this.#chatOrder.ensureInNormal(chatId);
  }

  async insertNormalChatIdTop(chatId: string): Promise<void> {
    return this.#chatOrder.insertNormalChatIdTop(chatId);
  }

  async removeFromAllOrderLists(chatId: string): Promise<void> {
    return this.#chatOrder.removeFromAllOrderLists(chatId);
  }

  async togglePin(chatId: string): Promise<{ isPinned: boolean }> {
    return this.#chatOrder.togglePin(chatId);
  }

  async toggleArchive(chatId: string): Promise<{ isArchived: boolean }> {
    return this.#chatOrder.toggleArchive(chatId);
  }

  async reorderWindow(list: string, rawOldOrder: unknown, rawNewOrder: unknown): Promise<ReorderResult> {
    return this.#chatOrder.reorderWindow(list, rawOldOrder, rawNewOrder);
  }

  async getSavedSearches(): Promise<SavedChatSearch[]> {
    return this.#savedSearches.getSavedSearches();
  }

  async addSavedSearch(savedSearch: SavedChatSearch): Promise<SavedChatSearch> {
    return this.#savedSearches.addSavedSearch(savedSearch);
  }

  async updateSavedSearch(searchId: string, patch: Partial<SavedChatSearch>): Promise<SavedChatSearch> {
    return this.#savedSearches.updateSavedSearch(searchId, patch);
  }

  async removeSavedSearch(searchId: string): Promise<boolean> {
    return this.#savedSearches.removeSavedSearch(searchId);
  }

  async reorderSavedSearches(oldOrder: unknown, newOrder: unknown): Promise<ReorderResult> {
    return this.#savedSearches.reorderSavedSearches(oldOrder, newOrder);
  }

  async getFolders(): Promise<ChatFolder[]> {
    return this.#folders.getFolders();
  }

  async addFolder(folder: ChatFolder): Promise<ChatFolder> {
    return this.#folders.addFolder(folder);
  }

  async updateFolder(folderId: string, patch: Partial<ChatFolder>): Promise<ChatFolder> {
    return this.#folders.updateFolder(folderId, patch);
  }

  async removeFolder(folderId: string): Promise<boolean> {
    return this.#folders.removeFolder(folderId);
  }

  async reorderRelative(chatId: string, refId: string, mode: string): Promise<ReorderResult> {
    return this.#chatOrder.reorderRelative(chatId, refId, mode);
  }
}
