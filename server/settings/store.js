// App settings persistence (project-settings.json). Manages ui preferences,
// path settings, chat-scoped session name overrides, and ordering lists.
// Maintains an in-memory #cache for getChatName() reads; high-level
// mutations always call loadSettings() then saveSettings() which keeps
// the cache in sync via identity sharing.

import { promises as fs } from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
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

function createEmpty() {
  return {
    ui: {},
    paths: {},
    chatNames: {},
    remoteSettingsVersion: 0,
    pinnedChatIds: [],
    normalChatIds: [],
    archivedChatIds: [],
    lastProvider: 'claude',
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

const FILTER_KEYS = ['textTokens', 'tags', 'providers', 'models'];
const VALID_FILTER_STATUS = new Set(['active', 'unread']);

function normalizeUiSettings(ui) {
  if (!ui || typeof ui !== 'object' || Array.isArray(ui)) return {};
  const normalized = { ...ui };
  if ('pinnedInsertPosition' in normalized) {
    normalized.pinnedInsertPosition = normalized.pinnedInsertPosition === 'bottom' ? 'bottom' : 'top';
  }
  if ('searchBarPosition' in normalized) {
    // Stores sidebar controls position in browser-local settings instead of
    // the shared remote settings snapshot.
    delete normalized.searchBarPosition;
  }
  return normalized;
}

function sanitizeStringArray(value) {
  return Array.isArray(value)
    ? value.filter((entry) => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean)
    : [];
}

function sanitizeFolderFilter(raw) {
  const filter = { textTokens: [], tags: [], providers: [], models: [] };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return filter;

  for (const key of FILTER_KEYS) {
    filter[key] = sanitizeStringArray(raw[key]);
  }

  if (typeof raw.status === 'string') {
    const status = raw.status.trim();
    if (VALID_FILTER_STATUS.has(status)) filter.status = status;
  }

  return filter;
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
    lastProvider: typeof parsed.lastProvider === 'string' ? parsed.lastProvider : 'claude',
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

function normalizeRemoteSettingsVersion(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

function bumpRemoteSettingsVersion(settings) {
  settings.remoteSettingsVersion = normalizeRemoteSettingsVersion(settings.remoteSettingsVersion) + 1;
}

function sameOrderedStringArray(left, right) {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

// Deduplicates an array of string IDs, preserving first occurrence.
function dedup(ids) {
  const out = [];
  const seen = new Set();
  for (const raw of ids) {
    if (typeof raw !== 'string') continue;
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

// Finds the starting index of a contiguous subsequence within a list.
function findWindowIndex(full, windowIds) {
  if (windowIds.length === 0 || windowIds.length > full.length) return -1;
  for (let i = 0; i <= full.length - windowIds.length; i += 1) {
    let ok = true;
    for (let j = 0; j < windowIds.length; j += 1) {
      if (full[i + j] !== windowIds[j]) { ok = false; break; }
    }
    if (ok) return i;
  }
  return -1;
}

// Replaces a contiguous window in the list with a new ordering.
function applyWindowReorder(full, oldOrder, newOrder) {
  const at = findWindowIndex(full, oldOrder);
  if (at < 0) return null;
  return [...full.slice(0, at), ...newOrder, ...full.slice(at + oldOrder.length)];
}

// Moves chatId relative to refId within the same list.
function moveRelative(list, chatId, refId, mode) {
  const from = list.indexOf(chatId);
  const ref = list.indexOf(refId);
  if (from < 0 || ref < 0) return null;
  const next = [...list];
  next.splice(from, 1);
  const refAfterRemoval = next.indexOf(refId);
  const insertAt = mode === 'above' ? refAfterRemoval : refAfterRemoval + 1;
  next.splice(insertAt, 0, chatId);
  return next;
}

// Resolves which order list a chat belongs to within a settings snapshot.
function resolveGroupInSettings(s, chatId) {
  const pinned = s.pinnedChatIds || [];
  if (pinned.includes(chatId)) return { group: 'pinned', list: pinned, key: 'pinnedChatIds' };
  const normal = s.normalChatIds || [];
  if (normal.includes(chatId)) return { group: 'normal', list: normal, key: 'normalChatIds' };
  const archived = s.archivedChatIds || [];
  if (archived.includes(chatId)) return { group: 'archived', list: archived, key: 'archivedChatIds' };
  return null;
}

export class SettingsStore extends EventEmitter {
  #cache = null;
  #workspaceDir;
  #writeLock = Promise.resolve();

  constructor(workspaceDir) {
    super();
    this.#workspaceDir = workspaceDir;
  }

  // Serializes read-modify-write cycles so concurrent mutations cannot
  // clobber each other's changes to project-settings.json.
  async #withLock(fn) {
    let release;
    const next = new Promise((resolve) => { release = resolve; });
    const prev = this.#writeLock;
    this.#writeLock = next;
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
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
    await fs.mkdir(this.#workspaceDir, { recursive: true });
    await fs.writeFile(this.#settingsPath(), JSON.stringify(settings, null, 2), 'utf8');
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

  async saveSettings(settings) {
    const validated = settings && typeof settings === 'object' && !Array.isArray(settings)
      ? settings
      : createEmpty();
    await this.#writeToDisk(validated);
    this.#cache = validated;
  }

  // Reconciles ordering lists against the chat registry on startup.
  // Ensures pinnedChatIds + normalChatIds + archivedChatIds cover all
  // chat IDs with no duplicates or unknown entries.
  async reconcileWithRegistry(registry) {
    return this.#withLock(async () => {
      const sessions = registry.listAllChats();
      const allChatIds = new Set(Object.keys(sessions));
      const currentSettings = await this.loadSettings();
      const beforePinned = dedup(currentSettings.pinnedChatIds || []);

      let pinned = dedup(currentSettings.pinnedChatIds || []);
      let normal = dedup(currentSettings.normalChatIds || []);
      let archived = dedup(currentSettings.archivedChatIds || []);

      let dirty = false;

      const filterUnknown = (list, name) => {
        const unknown = list.filter((id) => !allChatIds.has(id));
        if (unknown.length > 0) {
          console.log(`chat-order: removed unknown chat IDs from ${name}: ${JSON.stringify(unknown)}`);
          dirty = true;
          return list.filter((id) => allChatIds.has(id));
        }
        return list;
      };

      pinned = filterUnknown(pinned, 'pinnedChatIds');
      normal = filterUnknown(normal, 'normalChatIds');
      archived = filterUnknown(archived, 'archivedChatIds');

      // Resolve cross-list duplicates by precedence: pinned > normal > archived.
      const claimed = new Set();
      const dedupeAcross = (list, name) => {
        const dupes = [];
        const kept = [];
        for (const id of list) {
          if (claimed.has(id)) {
            dupes.push(id);
          } else {
            claimed.add(id);
            kept.push(id);
          }
        }
        if (dupes.length > 0) {
          console.log(`chat-order: removed duplicate chat IDs from ${name}: ${JSON.stringify(dupes)}`);
          dirty = true;
        }
        return kept;
      };

      pinned = dedupeAcross(pinned, 'pinnedChatIds');
      normal = dedupeAcross(normal, 'normalChatIds');
      archived = dedupeAcross(archived, 'archivedChatIds');

      // Add missing chat IDs to top of normalChatIds.
      const union = new Set([...pinned, ...normal, ...archived]);
      const missing = [];
      for (const id of allChatIds) {
        if (!union.has(id)) missing.push(id);
      }
      if (missing.length > 0) {
        missing.sort((a, b) => {
          if (a.length !== b.length) return b.length - a.length;
          return b.localeCompare(a);
        });
        normal = [...missing, ...normal];
        console.log(`chat-order: added missing chat IDs to normalChatIds: ${JSON.stringify(missing)}`);
        dirty = true;
      }

      if (dirty) {
        currentSettings.pinnedChatIds = pinned;
        currentSettings.normalChatIds = normal;
        currentSettings.archivedChatIds = archived;
        if (!sameOrderedStringArray(beforePinned, pinned)) {
          bumpRemoteSettingsVersion(currentSettings);
        }
        await this.saveSettings(currentSettings);
      }
    });
  }

  getChatName(chatId) {
    if (!chatId) return null;
    if (!this.#cache?.chatNames) return null;
    return this.#cache.chatNames[chatId] ?? null;
  }

  async setSessionName(chatId, title) {
    return this.#withLock(async () => {
      const settings = await this.loadSettings();
      if (!settings.chatNames) settings.chatNames = {};
      const trimmed = typeof title === 'string' ? title.trim() : '';
      if (!trimmed) {
        delete settings.chatNames[String(chatId)];
      } else {
        settings.chatNames[String(chatId)] = trimmed;
      }
      await this.saveSettings(settings);
      this.emitSessionNameChanged(chatId, trimmed || '');
    });
  }

  async removeSessionName(chatId) {
    return this.#withLock(async () => {
      const settings = await this.loadSettings();
      if (settings.chatNames) {
        delete settings.chatNames[String(chatId)];
        await this.saveSettings(settings);
      }
    });
  }

  async getUiSettings() {
    const settings = await this.loadSettings();
    return settings.ui || {};
  }

  async setUiSettings(patch) {
    return this.#withLock(async () => {
      const settings = await this.loadSettings();
      settings.ui = normalizeUiSettings({ ...(settings.ui || {}), ...patch });
      bumpRemoteSettingsVersion(settings);
      await this.saveSettings(settings);
      this.emitRemoteSettingsChanged();
      return settings.ui;
    });
  }

  async getPathSettings() {
    const settings = await this.loadSettings();
    return settings.paths || {};
  }

  async setPathSettings(patch) {
    return this.#withLock(async () => {
      const settings = await this.loadSettings();
      settings.paths = { ...(settings.paths || {}), ...patch };
      bumpRemoteSettingsVersion(settings);
      await this.saveSettings(settings);
      this.emitRemoteSettingsChanged();
      return settings.paths;
    });
  }

  async getPinnedChatIds() {
    const settings = await this.loadSettings();
    return settings.pinnedChatIds || [];
  }

  async getRemoteSettingsVersion() {
    const settings = await this.loadSettings();
    return normalizeRemoteSettingsVersion(settings.remoteSettingsVersion);
  }

  async getRemoteSettingsSnapshotSource() {
    const settings = await this.loadSettings();
    return {
      version: normalizeRemoteSettingsVersion(settings.remoteSettingsVersion),
      ui: settings.ui || {},
      paths: settings.paths || {},
      pinnedChatIds: settings.pinnedChatIds || [],
      lastProvider: settings.lastProvider || 'claude',
      lastProjectPath: settings.lastProjectPath || '',
      lastModel: settings.lastModel || '',
      lastApiProviderId: settings.lastApiProviderId ?? null,
      lastModelEndpointId: settings.lastModelEndpointId ?? null,
      lastModelProtocol: settings.lastModelProtocol ?? null,
      lastPermissionMode: normalizePermissionMode(settings.lastPermissionMode),
      lastThinkingMode: normalizeThinkingMode(settings.lastThinkingMode),
      lastClaudeThinkingMode: normalizeClaudeThinkingMode(settings.lastClaudeThinkingMode),
      lastAmpAgentMode: normalizeAmpAgentMode(settings.lastAmpAgentMode),
    };
  }

  async getArchivedChatIds() {
    const settings = await this.loadSettings();
    return settings.archivedChatIds || [];
  }

  async getLastPermissionMode() {
    const settings = await this.loadSettings();
    return normalizePermissionMode(settings.lastPermissionMode);
  }

  async getLastProvider() {
    const settings = await this.loadSettings();
    return settings.lastProvider || 'claude';
  }

  async getLastProjectPath() {
    const settings = await this.loadSettings();
    return settings.lastProjectPath || '';
  }

  async getLastModel() {
    const settings = await this.loadSettings();
    return settings.lastModel || '';
  }

  async getLastApiProviderId() {
    const settings = await this.loadSettings();
    return settings.lastApiProviderId ?? null;
  }

  async getLastModelEndpointId() {
    const settings = await this.loadSettings();
    return settings.lastModelEndpointId ?? null;
  }

  async getLastModelProtocol() {
    const settings = await this.loadSettings();
    return settings.lastModelProtocol ?? null;
  }

  async setLastChatDefaults(defaults) {
    return this.#withLock(async () => {
      const settings = await this.loadSettings();
      settings.lastProvider = typeof defaults?.provider === 'string'
        ? defaults.provider
        : (settings.lastProvider || 'claude');
      settings.lastProjectPath = typeof defaults?.projectPath === 'string'
        ? defaults.projectPath
        : (settings.lastProjectPath || '');
      settings.lastModel = typeof defaults?.model === 'string'
        ? defaults.model
        : (settings.lastModel || '');
      if (defaults?.apiProviderId !== undefined) {
        settings.lastApiProviderId = typeof defaults.apiProviderId === 'string' ? defaults.apiProviderId : null;
      }
      if (defaults?.modelEndpointId !== undefined) {
        settings.lastModelEndpointId = typeof defaults.modelEndpointId === 'string' ? defaults.modelEndpointId : null;
      }
      if (defaults?.modelProtocol !== undefined) {
        settings.lastModelProtocol = (defaults.modelProtocol === 'openai-compatible' || defaults.modelProtocol === 'anthropic-messages')
          ? defaults.modelProtocol
          : null;
      }
      settings.lastPermissionMode = normalizePermissionMode(
        defaults?.permissionMode,
        normalizePermissionMode(settings.lastPermissionMode),
      );
      settings.lastThinkingMode = normalizeThinkingMode(
        defaults?.thinkingMode,
        normalizeThinkingMode(settings.lastThinkingMode),
      );
      settings.lastClaudeThinkingMode = normalizeClaudeThinkingMode(
        defaults?.claudeThinkingMode,
        normalizeClaudeThinkingMode(settings.lastClaudeThinkingMode),
      );
      settings.lastAmpAgentMode = normalizeAmpAgentMode(
        defaults?.ampAgentMode,
        normalizeAmpAgentMode(settings.lastAmpAgentMode),
      );
      bumpRemoteSettingsVersion(settings);
      await this.saveSettings(settings);
      this.emitRemoteSettingsChanged();
    });
  }

  async setLastPermissionMode(mode) {
    return this.setLastChatDefaults({ permissionMode: mode });
  }

  async getLastThinkingMode() {
    const settings = await this.loadSettings();
    return normalizeThinkingMode(settings.lastThinkingMode);
  }

  async setLastThinkingMode(mode) {
    return this.setLastChatDefaults({ thinkingMode: mode });
  }

  async getLastClaudeThinkingMode() {
    const settings = await this.loadSettings();
    return normalizeClaudeThinkingMode(settings.lastClaudeThinkingMode);
  }

  async setLastClaudeThinkingMode(mode) {
    return this.setLastChatDefaults({ claudeThinkingMode: mode });
  }

  async getLastAmpAgentMode() {
    const settings = await this.loadSettings();
    return normalizeAmpAgentMode(settings.lastAmpAgentMode);
  }

  async setLastAmpAgentMode(mode) {
    return this.setLastChatDefaults({ ampAgentMode: mode });
  }

  async getNormalChatIds() {
    const settings = await this.loadSettings();
    return settings.normalChatIds || [];
  }

  // Ensures chatId is at the top of normalChatIds in a single disk
  // round-trip, removing it from pinned/archived if present.
  async ensureInNormal(chatId) {
    return this.#withLock(async () => {
      const settings = await this.loadSettings();
      const beforePinned = dedup(settings.pinnedChatIds || []);
      for (const key of ['pinnedChatIds', 'normalChatIds', 'archivedChatIds']) {
        const ids = settings[key] || [];
        if (ids.includes(chatId)) {
          settings[key] = ids.filter((id) => id !== chatId);
        }
      }
      settings.normalChatIds = [chatId, ...(settings.normalChatIds || [])];
      const afterPinned = dedup(settings.pinnedChatIds || []);
      const pinnedChanged = !sameOrderedStringArray(beforePinned, afterPinned);
      if (pinnedChanged) {
        bumpRemoteSettingsVersion(settings);
      }
      await this.saveSettings(settings);
      if (pinnedChanged) {
        this.emitRemoteSettingsChanged();
      }
      this.emitListChanged('chat-added', chatId);
    });
  }

  async insertNormalChatIdTop(chatId) {
    return this.#withLock(async () => {
      const settings = await this.loadSettings();
      const ids = (settings.normalChatIds || []).filter((id) => id !== chatId);
      settings.normalChatIds = [chatId, ...ids];
      await this.saveSettings(settings);
    });
  }

  async removeFromAllOrderLists(chatId) {
    return this.#withLock(async () => {
      const settings = await this.loadSettings();
      const beforePinned = dedup(settings.pinnedChatIds || []);
      let dirty = false;
      for (const key of ['pinnedChatIds', 'normalChatIds', 'archivedChatIds']) {
        const ids = settings[key] || [];
        if (ids.includes(chatId)) {
          settings[key] = ids.filter((id) => id !== chatId);
          dirty = true;
        }
      }
      if (!dirty) return;

      const afterPinned = dedup(settings.pinnedChatIds || []);
      const pinnedChanged = !sameOrderedStringArray(beforePinned, afterPinned);
      if (pinnedChanged) {
        bumpRemoteSettingsVersion(settings);
      }
      await this.saveSettings(settings);
      if (pinnedChanged) {
        this.emitRemoteSettingsChanged();
      }
    });
  }

  // Toggles pin state for a chat in a single disk round-trip.
  async togglePin(chatId) {
    return this.#withLock(async () => {
      const s = await this.loadSettings();
      const pinned = s.pinnedChatIds || [];
      const isPinned = pinned.includes(chatId);

      if (isPinned) {
        s.pinnedChatIds = pinned.filter((id) => id !== chatId);
        s.normalChatIds = [chatId, ...(s.normalChatIds || []).filter((id) => id !== chatId)];
      } else {
        const position = (s.ui?.pinnedInsertPosition === 'bottom') ? 'bottom' : 'top';
        s.normalChatIds = (s.normalChatIds || []).filter((id) => id !== chatId);
        s.archivedChatIds = (s.archivedChatIds || []).filter((id) => id !== chatId);
        s.pinnedChatIds = position === 'bottom' ? [...pinned, chatId] : [chatId, ...pinned];
      }

      bumpRemoteSettingsVersion(s);
      await this.saveSettings(s);
      this.emitRemoteSettingsChanged();
      this.emitListChanged('pinned-toggled', chatId);
      return { isPinned: !isPinned };
    });
  }

  // Toggles archive state for a chat in a single disk round-trip.
  async toggleArchive(chatId) {
    return this.#withLock(async () => {
      const s = await this.loadSettings();
      const beforePinned = dedup(s.pinnedChatIds || []);
      const archived = s.archivedChatIds || [];
      const isArchived = archived.includes(chatId);

      if (isArchived) {
        s.archivedChatIds = archived.filter((id) => id !== chatId);
        s.normalChatIds = [chatId, ...(s.normalChatIds || []).filter((id) => id !== chatId)];
      } else {
        s.pinnedChatIds = (s.pinnedChatIds || []).filter((id) => id !== chatId);
        s.normalChatIds = (s.normalChatIds || []).filter((id) => id !== chatId);
        s.archivedChatIds = [chatId, ...archived.filter((id) => id !== chatId)];
      }

      const afterPinned = dedup(s.pinnedChatIds || []);
      const pinnedChanged = !sameOrderedStringArray(beforePinned, afterPinned);
      if (pinnedChanged) {
        bumpRemoteSettingsVersion(s);
      }
      await this.saveSettings(s);
      if (pinnedChanged) {
        this.emitRemoteSettingsChanged();
      }
      this.emitListChanged('archive-toggled', chatId);
      return { isArchived: !isArchived };
    });
  }

  // Validates and applies a window reorder within a group.
  async reorderWindow(list, rawOldOrder, rawNewOrder) {
    const normOld = dedup(rawOldOrder);
    const normNew = dedup(rawNewOrder);

    if (normOld.length === 0) return { success: false, error: 'oldOrder must not be empty' };
    if (normOld.length !== normNew.length) return { success: false, error: 'oldOrder and newOrder must have the same length' };

    const oldSet = new Set(normOld);
    const newSet = new Set(normNew);
    if (normOld.length !== oldSet.size || normNew.length !== newSet.size) {
      return { success: false, error: 'oldOrder and newOrder must contain unique IDs' };
    }
    for (const id of normNew) {
      if (!oldSet.has(id)) return { success: false, error: 'oldOrder and newOrder must contain the same IDs' };
    }

    return this.#withLock(async () => {
      const s = await this.loadSettings();
      const key = list === 'pinned' ? 'pinnedChatIds' : list === 'archived' ? 'archivedChatIds' : 'normalChatIds';
      const current = dedup(s[key] || []);

      const currentSet = new Set(current);
      for (const id of normOld) {
        if (!currentSet.has(id)) return { success: false, error: `ID "${id}" is not in the ${list} list` };
      }

      const result = applyWindowReorder(current, normOld, normNew);
      if (!result) return { success: false, error: 'oldOrder is not a contiguous subsequence of the current list' };

      s[key] = result;
      if (list === 'pinned') {
        bumpRemoteSettingsVersion(s);
      }
      await this.saveSettings(s);

      const anchorChatId = normNew[0] || list;
      if (list === 'pinned') {
        this.emitRemoteSettingsChanged();
      }
      this.emitListChanged('chats-reordered', anchorChatId);
      return { success: true };
    });
  }

  async getSavedSearches() {
    const settings = await this.loadSettings();
    return settings.savedChatSearches || [];
  }

  async addSavedSearch(savedSearch) {
    return this.#withLock(async () => {
      const s = await this.loadSettings();
      const searches = s.savedChatSearches || [];
      if (searches.some((entry) => entry.id === savedSearch.id)) {
        throw new Error(`Saved search with ID ${savedSearch.id} already exists`);
      }
      s.savedChatSearches = [...searches, savedSearch];
      await this.saveSettings(s);
      return savedSearch;
    });
  }

  async updateSavedSearch(searchId, patch) {
    return this.#withLock(async () => {
      const s = await this.loadSettings();
      const searches = s.savedChatSearches || [];
      const idx = searches.findIndex((entry) => entry.id === searchId);
      if (idx < 0) {
        throw new Error(`Saved search not found: ${searchId}`);
      }
      searches[idx] = { ...searches[idx], ...patch };
      s.savedChatSearches = searches;
      await this.saveSettings(s);
      return searches[idx];
    });
  }

  async removeSavedSearch(searchId) {
    return this.#withLock(async () => {
      const s = await this.loadSettings();
      const searches = s.savedChatSearches || [];
      const idx = searches.findIndex((entry) => entry.id === searchId);
      if (idx < 0) return false;
      s.savedChatSearches = searches.filter((entry) => entry.id !== searchId);
      await this.saveSettings(s);
      return true;
    });
  }

  async reorderSavedSearches(oldOrder, newOrder) {
    const normOld = dedup(oldOrder);
    const normNew = dedup(newOrder);

    if (normOld.length === 0) return { success: false, error: 'oldOrder must not be empty' };
    if (normOld.length !== normNew.length) return { success: false, error: 'oldOrder and newOrder must have the same length' };

    const oldSet = new Set(normOld);
    const newSet = new Set(normNew);
    if (normOld.length !== oldSet.size || normNew.length !== newSet.size) {
      return { success: false, error: 'oldOrder and newOrder must contain unique IDs' };
    }
    for (const id of normNew) {
      if (!oldSet.has(id)) return { success: false, error: 'oldOrder and newOrder must contain the same IDs' };
    }

    return this.#withLock(async () => {
      const s = await this.loadSettings();
      const searches = s.savedChatSearches || [];
      const currentIds = searches.map((entry) => entry.id);

      const result = applyWindowReorder(currentIds, normOld, normNew);
      if (!result) return { success: false, error: 'oldOrder is not a contiguous subsequence of the current list' };

      const byId = new Map(searches.map((entry) => [entry.id, entry]));
      s.savedChatSearches = result.map((id) => byId.get(id)).filter(Boolean);
      await this.saveSettings(s);
      return { success: true };
    });
  }

  async getFolders() {
    const settings = await this.loadSettings();
    return settings.chatFolders || [];
  }

  async addFolder(folder) {
    return this.#withLock(async () => {
      const s = await this.loadSettings();
      const folders = s.chatFolders || [];
      if (folders.some((f) => f.id === folder.id)) {
        throw new Error(`Folder with ID ${folder.id} already exists`);
      }
      s.chatFolders = [...folders, folder];
      await this.saveSettings(s);
      return folder;
    });
  }

  async updateFolder(folderId, patch) {
    return this.#withLock(async () => {
      const s = await this.loadSettings();
      const folders = s.chatFolders || [];
      const idx = folders.findIndex((f) => f.id === folderId);
      if (idx < 0) {
        throw new Error(`Folder not found: ${folderId}`);
      }
      folders[idx] = { ...folders[idx], ...patch };
      s.chatFolders = folders;
      await this.saveSettings(s);
      return folders[idx];
    });
  }

  async removeFolder(folderId) {
    return this.#withLock(async () => {
      const s = await this.loadSettings();
      const folders = s.chatFolders || [];
      const idx = folders.findIndex((f) => f.id === folderId);
      if (idx < 0) return false;
      s.chatFolders = folders.filter((f) => f.id !== folderId);
      await this.saveSettings(s);
      return true;
    });
  }

  // Moves a single chat relative to a neighbor within the same group.
  async reorderRelative(chatId, refId, mode) {
    return this.#withLock(async () => {
      const s = await this.loadSettings();
      const chatGroup = resolveGroupInSettings(s, chatId);
      const refGroup = resolveGroupInSettings(s, refId);

      if (!chatGroup || !refGroup) return { success: false, error: 'Chat not found in any order list' };
      if (chatGroup.group !== refGroup.group) return { success: false, error: 'Cross-group reorder is not allowed' };

      const result = moveRelative(chatGroup.list, chatId, refId, mode);
      if (!result) return { success: false, error: 'Chat positions could not be resolved' };

      s[chatGroup.key] = result;
      if (chatGroup.group === 'pinned') {
        bumpRemoteSettingsVersion(s);
      }
      await this.saveSettings(s);
      if (chatGroup.group === 'pinned') {
        this.emitRemoteSettingsChanged();
      }
      this.emitListChanged('chats-reordered-quick', chatId);
      return { success: true };
    });
  }
}
