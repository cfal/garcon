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
} from '../../common/chat-modes.ts';

const SETTINGS_WRITE_LOCK_KEY = 'project-settings';

function createEmpty() {
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

function sanitizeFolder(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

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

function sanitizeSavedSearch(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

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

function sanitize(parsed) {
  const chatFolders = Array.isArray(parsed.chatFolders)
    ? parsed.chatFolders.map(sanitizeFolder).filter(Boolean)
    : [];

  const savedChatSearches = Array.isArray(parsed.savedChatSearches)
    ? parsed.savedChatSearches.map(sanitizeSavedSearch).filter(Boolean)
    : [];

  return {
    ui: normalizeUiSettings(parsed.ui),
    paths: parsed.paths && typeof parsed.paths === 'object' ? parsed.paths : {},
    chatNames: parsed.chatNames && typeof parsed.chatNames === 'object' ? parsed.chatNames : {},
    remoteSettingsVersion: normalizeRemoteSettingsVersion(parsed.remoteSettingsVersion),
    pinnedChatIds: sanitizeStringArray(parsed.pinnedChatIds),
    normalChatIds: sanitizeStringArray(parsed.normalChatIds),
    archivedChatIds: sanitizeStringArray(parsed.archivedChatIds),
    lastAgentId: typeof parsed.lastAgentId === 'string' ? parsed.lastAgentId : 'claude',
    lastProjectPath: typeof parsed.lastProjectPath === 'string' ? parsed.lastProjectPath : '',
    lastModel: typeof parsed.lastModel === 'string' ? parsed.lastModel : '',
    lastApiProviderId: typeof parsed.lastApiProviderId === 'string' ? parsed.lastApiProviderId : null,
    lastModelEndpointId: typeof parsed.lastModelEndpointId === 'string' ? parsed.lastModelEndpointId : null,
    lastModelProtocol: (parsed.lastModelProtocol === 'openai-compatible' || parsed.lastModelProtocol === 'anthropic-messages')
      ? parsed.lastModelProtocol
      : null,
    lastPermissionMode: normalizePermissionMode(parsed.lastPermissionMode),
    lastThinkingMode: normalizeThinkingMode(parsed.lastThinkingMode),
    lastClaudeThinkingMode: normalizeClaudeThinkingMode(parsed.lastClaudeThinkingMode),
    lastAmpAgentMode: normalizeAmpAgentMode(parsed.lastAmpAgentMode),
    chatFolders,
    savedChatSearches,
  };
}

export class SettingsStore extends EventEmitter {
  #cache = null;
  #workspaceDir;
  #writeLock = new KeyedPromiseLock();
  #chatNames;
  #uiSettings;
  #lastChatDefaults;
  #chatOrder;
  #savedSearches;
  #folders;

  constructor(workspaceDir) {
    super();
    this.#workspaceDir = workspaceDir;
    const context = {
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
  async #withLock(fn) {
    return this.#writeLock.runExclusive(SETTINGS_WRITE_LOCK_KEY, fn);
  }

  emitSessionNameChanged(chatId, title) { this.emit('session-name-changed', chatId, title); }
  onSessionNameChanged(cb) { this.on('session-name-changed', cb); }
  emitListChanged(reason, chatId) { this.emit('list-changed', reason, chatId); }
  onListChanged(cb) { this.on('list-changed', cb); }
  emitRemoteSettingsChanged() { this.emit('remote-settings-changed'); }
  onRemoteSettingsChanged(cb) { this.on('remote-settings-changed', cb); }

  #settingsPath() {
    return path.join(this.#workspaceDir, 'project-settings.json');
  }

  async #writeToDisk(settings) {
    await writeJsonFileAtomic(this.#settingsPath(), settings);
  }

  async #readFromDisk() {
    try {
      const raw = await fs.readFile(this.#settingsPath(), 'utf8');
      const parsed = JSON.parse(raw);
      return sanitize(parsed);
    } catch (error) {
      if (error.code === 'ENOENT') return createEmpty();
      console.warn('settings: invalid project-settings.json, using empty settings:', error.message);
      return createEmpty();
    }
  }

  async init() {
    await fs.mkdir(this.#workspaceDir, { recursive: true });
    this.#cache = await this.#readFromDisk();
    return this.#cache;
  }

  async loadSettings() {
    const newCache = await this.#readFromDisk();
    this.#cache = newCache;
    return newCache;
  }

  #getCachedSettings() {
    if (!this.#cache) {
      this.#cache = createEmpty();
    }
    return this.#cache;
  }

  async saveSettings(settings) {
    const validated = settings && typeof settings === 'object' && !Array.isArray(settings)
      ? settings
      : createEmpty();
    await this.#writeToDisk(validated);
    this.#cache = validated;
  }

  async #saveSettingsAndMaybeEmitRemote(settings, remoteSettingsChanged) {
    await this.saveSettings(settings);
    if (remoteSettingsChanged) {
      this.emitRemoteSettingsChanged();
    }
  }

  async reconcileWithRegistry(registry) {
    return this.#chatOrder.reconcileWithRegistry(registry);
  }

  getChatName(chatId) {
    return this.#chatNames.getChatName(chatId);
  }

  async setSessionName(chatId, title) {
    return this.#chatNames.setSessionName(chatId, title);
  }

  async removeSessionName(chatId) {
    return this.#chatNames.removeSessionName(chatId);
  }

  async getUiSettings() {
    return this.#uiSettings.getUiSettings();
  }

  async setUiSettings(patch) {
    return this.#uiSettings.setUiSettings(patch);
  }

  async getPathSettings() {
    return this.#uiSettings.getPathSettings();
  }

  async setPathSettings(patch) {
    return this.#uiSettings.setPathSettings(patch);
  }

  async getPinnedChatIds() {
    return this.#chatOrder.getPinnedChatIds();
  }

  async getRemoteSettingsVersion() {
    return this.#uiSettings.getRemoteSettingsVersion();
  }

  async getRemoteSettingsSnapshotSource() {
    return this.#uiSettings.getRemoteSettingsSnapshotSource();
  }

  async getArchivedChatIds() {
    return this.#chatOrder.getArchivedChatIds();
  }

  async getLastPermissionMode() {
    return this.#lastChatDefaults.getLastPermissionMode();
  }

  async getLastAgentId() {
    return this.#lastChatDefaults.getLastAgentId();
  }

  async getLastProjectPath() {
    return this.#lastChatDefaults.getLastProjectPath();
  }

  async getLastModel() {
    return this.#lastChatDefaults.getLastModel();
  }

  async getLastApiProviderId() {
    return this.#lastChatDefaults.getLastApiProviderId();
  }

  async getLastModelEndpointId() {
    return this.#lastChatDefaults.getLastModelEndpointId();
  }

  async getLastModelProtocol() {
    return this.#lastChatDefaults.getLastModelProtocol();
  }

  async setLastChatDefaults(defaults) {
    return this.#lastChatDefaults.setLastChatDefaults(defaults);
  }

  async setLastPermissionMode(mode) {
    return this.#lastChatDefaults.setLastPermissionMode(mode);
  }

  async getLastThinkingMode() {
    return this.#lastChatDefaults.getLastThinkingMode();
  }

  async setLastThinkingMode(mode) {
    return this.#lastChatDefaults.setLastThinkingMode(mode);
  }

  async getLastClaudeThinkingMode() {
    return this.#lastChatDefaults.getLastClaudeThinkingMode();
  }

  async setLastClaudeThinkingMode(mode) {
    return this.#lastChatDefaults.setLastClaudeThinkingMode(mode);
  }

  async getLastAmpAgentMode() {
    return this.#lastChatDefaults.getLastAmpAgentMode();
  }

  async setLastAmpAgentMode(mode) {
    return this.#lastChatDefaults.setLastAmpAgentMode(mode);
  }

  async getNormalChatIds() {
    return this.#chatOrder.getNormalChatIds();
  }

  async ensureInNormal(chatId) {
    return this.#chatOrder.ensureInNormal(chatId);
  }

  async insertNormalChatIdTop(chatId) {
    return this.#chatOrder.insertNormalChatIdTop(chatId);
  }

  async removeFromAllOrderLists(chatId) {
    return this.#chatOrder.removeFromAllOrderLists(chatId);
  }

  async togglePin(chatId) {
    return this.#chatOrder.togglePin(chatId);
  }

  async toggleArchive(chatId) {
    return this.#chatOrder.toggleArchive(chatId);
  }

  async reorderWindow(list, rawOldOrder, rawNewOrder) {
    return this.#chatOrder.reorderWindow(list, rawOldOrder, rawNewOrder);
  }

  async getSavedSearches() {
    return this.#savedSearches.getSavedSearches();
  }

  async addSavedSearch(savedSearch) {
    return this.#savedSearches.addSavedSearch(savedSearch);
  }

  async updateSavedSearch(searchId, patch) {
    return this.#savedSearches.updateSavedSearch(searchId, patch);
  }

  async removeSavedSearch(searchId) {
    return this.#savedSearches.removeSavedSearch(searchId);
  }

  async reorderSavedSearches(oldOrder, newOrder) {
    return this.#savedSearches.reorderSavedSearches(oldOrder, newOrder);
  }

  async getFolders() {
    return this.#folders.getFolders();
  }

  async addFolder(folder) {
    return this.#folders.addFolder(folder);
  }

  async updateFolder(folderId, patch) {
    return this.#folders.updateFolder(folderId, patch);
  }

  async removeFolder(folderId) {
    return this.#folders.removeFolder(folderId);
  }

  async reorderRelative(chatId, refId, mode) {
    return this.#chatOrder.reorderRelative(chatId, refId, mode);
  }
}
