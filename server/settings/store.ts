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
  FeatureSettingsStore,
  FolderStore,
  SavedSearchStore,
  StartupDefaultsStore,
  UiSettingsStore,
} from './domain-stores.js';
import {
  DEFAULT_REMOTE_FEATURE_SETTINGS,
  normalizeRemoteFeatureSettings,
} from '../../common/settings.js';
import {
  normalizeRemoteSettingsVersion,
  normalizeUiSettings,
  sanitizeFolderFilter,
  sanitizeStringArray,
} from './settings-shared.js';
import {
  defaultExecutionDefaults,
  dedupeRecentAgentSettings,
  legacyExecutionDefaults,
  legacyRecentAgentSetting,
  sanitizeExecutionDefaultsSettings,
  sanitizePathSettings,
  sanitizeRecentAgentSettings,
} from './startup-recents.js';
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
const LEGACY_LAST_KEYS = [
  'lastAgentId',
  'lastProjectPath',
  'lastModel',
  'lastApiProviderId',
  'lastModelEndpointId',
  'lastModelProtocol',
  'lastPermissionMode',
  'lastThinkingMode',
] as const;

interface SanitizedSettingsResult {
  settings: ProjectSettings;
  migrated: boolean;
}

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
    features: structuredClone(DEFAULT_REMOTE_FEATURE_SETTINGS),
    ui: {},
    paths: {},
    chatNames: {},
    remoteSettingsVersion: 0,
    pinnedChatIds: [],
    normalChatIds: [],
    archivedChatIds: [],
    recentAgentSettings: [],
    executionDefaults: {
      global: defaultExecutionDefaults(),
      byAgent: {},
    },
    chatFolders: [],
    savedChatSearches: [],
  };
}

function cloneSettings(settings: ProjectSettings): ProjectSettings {
  return sanitizeProjectSettings(structuredClone(settings)).settings;
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

function sanitizeProjectSettings(parsed: unknown): SanitizedSettingsResult {
  const raw = isRecord(parsed) ? parsed : {};
  let migrated = !isRecord(parsed);
  const rawFeatures = isRecord(raw.features) ? raw.features : null;
  const rawTranscriptSearch = isRecord(rawFeatures?.transcriptSearch)
    ? rawFeatures.transcriptSearch
    : null;
  if (typeof rawTranscriptSearch?.enabled !== 'boolean') migrated = true;
  const features = normalizeRemoteFeatureSettings(raw.features);
  const chatFolders = Array.isArray(raw.chatFolders)
    ? raw.chatFolders.map(sanitizeFolder).filter((folder): folder is ChatFolder => Boolean(folder))
    : [];
  if (Array.isArray(raw.chatFolders) && chatFolders.length !== raw.chatFolders.length) migrated = true;

  const savedChatSearches = Array.isArray(raw.savedChatSearches)
    ? raw.savedChatSearches.map(sanitizeSavedSearch).filter((search): search is SavedChatSearch => Boolean(search))
    : [];
  if (Array.isArray(raw.savedChatSearches) && savedChatSearches.length !== raw.savedChatSearches.length) migrated = true;

  const hasLegacyLastFields = LEGACY_LAST_KEYS.some((key) => key in raw);
  if (hasLegacyLastFields) migrated = true;

  const pathResult = sanitizePathSettings(raw);
  if (pathResult.migrated) migrated = true;

  const recentResult = sanitizeRecentAgentSettings(raw.recentAgentSettings);
  if (recentResult.migrated || !Array.isArray(raw.recentAgentSettings)) migrated = true;
  const legacyRecent = legacyRecentAgentSetting(raw);
  const recentAgentSettings = dedupeRecentAgentSettings([
    ...recentResult.entries,
    ...(legacyRecent ? [legacyRecent] : []),
  ]);

  const executionResult = sanitizeExecutionDefaultsSettings(raw.executionDefaults);
  if (executionResult.migrated) migrated = true;
  let executionDefaults = executionResult.defaults;
  const legacyAgentId = typeof raw.lastAgentId === 'string' ? raw.lastAgentId.trim() : '';
  const hasLegacyModeFields = [
    'lastPermissionMode',
    'lastThinkingMode',
  ].some((key) => key in raw);
  if (hasLegacyModeFields) {
    const legacyDefaults = legacyExecutionDefaults(raw);
    executionDefaults = {
      global: legacyDefaults,
      byAgent: {
        ...executionDefaults.byAgent,
        ...(legacyAgentId ? { [legacyAgentId]: legacyDefaults } : {}),
      },
    };
  }

  return {
    settings: {
    features,
    ui: normalizeUiSettings(raw.ui),
    paths: pathResult.paths,
    chatNames: isRecord(raw.chatNames) ? stringRecord(raw.chatNames) : {},
    remoteSettingsVersion: normalizeRemoteSettingsVersion(raw.remoteSettingsVersion),
    pinnedChatIds: sanitizeStringArray(raw.pinnedChatIds),
    normalChatIds: sanitizeStringArray(raw.normalChatIds),
    archivedChatIds: sanitizeStringArray(raw.archivedChatIds),
    recentAgentSettings,
    executionDefaults,
    chatFolders,
    savedChatSearches,
    },
    migrated,
  };
}

export class SettingsStore extends EventEmitter {
  #cache: ProjectSettings | null = null;
  #mutationDraft: ProjectSettings | null = null;
  #workspaceDir: string;
  #writeLock = new KeyedPromiseLock();
  #chatNames: ChatNameStore;
  #uiSettings: UiSettingsStore;
  #featureSettings: FeatureSettingsStore;
  #startupDefaults: StartupDefaultsStore;
  #chatOrder: ChatOrderStore;
  #savedSearches: SavedSearchStore;
  #folders: FolderStore;

  constructor(workspaceDir: string) {
    super();
    this.#workspaceDir = workspaceDir;
    const context: SettingsStoreContext = {
      readSettings: () => this.#readSettings(),
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
    this.#featureSettings = new FeatureSettingsStore(context);
    this.#startupDefaults = new StartupDefaultsStore(context);
    this.#chatOrder = new ChatOrderStore(context);
    this.#savedSearches = new SavedSearchStore(context);
    this.#folders = new FolderStore(context);
  }

  // Serializes read-modify-write cycles so concurrent mutations cannot
  // clobber each other's changes to project-settings.json.
  async #withLock<T>(fn: SettingsMutation<T>): Promise<T> {
    return this.#writeLock.runExclusive(SETTINGS_WRITE_LOCK_KEY, async () => {
      const previousDraft = this.#mutationDraft;
      this.#mutationDraft = cloneSettings(this.#getCachedSettings());
      try {
        return await Promise.resolve(fn());
      } finally {
        this.#mutationDraft = previousDraft;
      }
    });
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

  async #readFromDiskWithMigration(): Promise<SanitizedSettingsResult> {
    try {
      const raw = await fs.readFile(this.#settingsPath(), 'utf8');
      const parsed = JSON.parse(raw);
      return sanitizeProjectSettings(parsed);
    } catch (error) {
      if (hasNodeErrorCode(error, 'ENOENT')) {
        return { settings: createEmpty(), migrated: false };
      }
      logger.warn('settings: invalid project-settings.json, using empty settings:', errorMessage(error));
      return { settings: createEmpty(), migrated: true };
    }
  }

  async init(): Promise<ProjectSettings> {
    await fs.mkdir(this.#workspaceDir, { recursive: true });
    const { settings, migrated } = await this.#readFromDiskWithMigration();
    this.#cache = settings;
    if (migrated) {
      await this.#writeToDisk(settings);
    }
    return this.#cache;
  }

  async loadSettings(): Promise<ProjectSettings> {
    const { settings: newCache, migrated } = await this.#readFromDiskWithMigration();
    this.#cache = newCache;
    if (migrated) {
      await this.#writeToDisk(newCache);
    }
    return newCache;
  }

  #getCachedSettings(): ProjectSettings {
    if (!this.#cache) {
      this.#cache = createEmpty();
    }
    return this.#cache;
  }

  #readSettings(): ProjectSettings {
    return this.#mutationDraft ?? this.#getCachedSettings();
  }

  async saveSettings(settings: unknown): Promise<void> {
    const validated = sanitizeProjectSettings(settings).settings;
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

  getUiSettings(): ProjectSettings['ui'] {
    return this.#uiSettings.getUiSettings();
  }

  getFeatureSettings(): ProjectSettings['features'] {
    return this.#featureSettings.getFeatureSettings();
  }

  async setTranscriptSearchEnabled(enabled: boolean): Promise<ProjectSettings['features']> {
    return this.#featureSettings.setTranscriptSearchEnabled(enabled);
  }

  async setUiSettings(patch: Record<string, unknown>): Promise<ProjectSettings['ui']> {
    return this.#uiSettings.setUiSettings(patch);
  }

  getPathSettings(): ProjectSettings['paths'] {
    return this.#uiSettings.getPathSettings();
  }

  async setPathSettings(patch: Record<string, unknown>): Promise<ProjectSettings['paths']> {
    return this.#uiSettings.setPathSettings(patch);
  }

  getPinnedChatIds(): string[] {
    return this.#chatOrder.getPinnedChatIds();
  }

  getRemoteSettingsVersion(): number {
    return this.#uiSettings.getRemoteSettingsVersion();
  }

  getRemoteSettingsSnapshotSource(): {
    version: number;
    features: ProjectSettings['features'];
    ui: ProjectSettings['ui'];
    paths: ProjectSettings['paths'];
    pinnedChatIds: string[];
    recentAgentSettings: ProjectSettings['recentAgentSettings'];
    executionDefaults: ProjectSettings['executionDefaults'];
  } {
    return {
      ...this.#uiSettings.getRemoteSettingsSnapshotSource(),
      features: this.#featureSettings.getFeatureSettings(),
    };
  }

  getArchivedChatIds(): string[] {
    return this.#chatOrder.getArchivedChatIds();
  }

  getRecentAgentSettings(): ProjectSettings['recentAgentSettings'] {
    return this.#startupDefaults.getRecentAgentSettings();
  }

  getRecentProjectPaths(): string[] {
    return this.#startupDefaults.getRecentProjectPaths();
  }

  getExecutionDefaults(): ProjectSettings['executionDefaults'] {
    return this.#startupDefaults.getExecutionDefaults();
  }

  async recordChatStartup(defaults: Record<string, unknown> | null | undefined): Promise<void> {
    return this.#startupDefaults.recordChatStartup(defaults);
  }

  async updateExecutionDefaultsForAgent(
    agentId: string,
    patch: Partial<ProjectSettings['executionDefaults']['global']>,
  ): Promise<void> {
    return this.#startupDefaults.updateExecutionDefaultsForAgent(agentId, patch);
  }

  getNormalChatIds(): string[] {
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

  getSavedSearches(): SavedChatSearch[] {
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

  getFolders(): ChatFolder[] {
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
