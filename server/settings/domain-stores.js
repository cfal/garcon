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
import {
  normalizeRemoteSettingsVersion,
  normalizeUiSettings,
} from './settings-shared.js';

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

function bumpRemoteSettingsVersionForPinnedChange(settings, beforePinned) {
  const afterPinned = dedup(settings.pinnedChatIds || []);
  const changed = !sameOrderedStringArray(beforePinned, afterPinned);
  if (changed) {
    bumpRemoteSettingsVersion(settings);
  }
  return changed;
}

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

function applyWindowReorder(full, oldOrder, newOrder) {
  const at = findWindowIndex(full, oldOrder);
  if (at < 0) return null;
  return [...full.slice(0, at), ...newOrder, ...full.slice(at + oldOrder.length)];
}

function validateWindowReorder(rawOldOrder, rawNewOrder) {
  const oldOrder = dedup(rawOldOrder);
  const newOrder = dedup(rawNewOrder);

  if (oldOrder.length === 0) return { success: false, error: 'oldOrder must not be empty' };
  if (oldOrder.length !== newOrder.length) return { success: false, error: 'oldOrder and newOrder must have the same length' };

  const oldSet = new Set(oldOrder);
  const newSet = new Set(newOrder);
  if (oldOrder.length !== oldSet.size || newOrder.length !== newSet.size) {
    return { success: false, error: 'oldOrder and newOrder must contain unique IDs' };
  }
  for (const id of newOrder) {
    if (!oldSet.has(id)) return { success: false, error: 'oldOrder and newOrder must contain the same IDs' };
  }

  return { success: true, oldOrder, newOrder };
}

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

function resolveGroupInSettings(s, chatId) {
  const pinned = s.pinnedChatIds || [];
  if (pinned.includes(chatId)) return { group: 'pinned', list: pinned, key: 'pinnedChatIds' };
  const normal = s.normalChatIds || [];
  if (normal.includes(chatId)) return { group: 'normal', list: normal, key: 'normalChatIds' };
  const archived = s.archivedChatIds || [];
  if (archived.includes(chatId)) return { group: 'archived', list: archived, key: 'archivedChatIds' };
  return null;
}

export class ChatNameStore {
  #context;

  constructor(context) {
    this.#context = context;
  }

  getChatName(chatId) {
    const settings = this.#context.readSettings();
    if (!chatId) return null;
    if (!settings.chatNames) return null;
    return settings.chatNames[chatId] ?? null;
  }

  async setSessionName(chatId, title) {
    return this.#context.mutate(async () => {
      const settings = this.#context.readSettings();
      if (!settings.chatNames) settings.chatNames = {};
      const trimmed = typeof title === 'string' ? title.trim() : '';
      if (!trimmed) {
        delete settings.chatNames[String(chatId)];
      } else {
        settings.chatNames[String(chatId)] = trimmed;
      }
      await this.#context.save(settings);
      this.#context.emitSessionNameChanged(chatId, trimmed || '');
    });
  }

  async removeSessionName(chatId) {
    return this.#context.mutate(async () => {
      const settings = this.#context.readSettings();
      if (settings.chatNames) {
        delete settings.chatNames[String(chatId)];
        await this.#context.save(settings);
      }
    });
  }
}

export class UiSettingsStore {
  #context;

  constructor(context) {
    this.#context = context;
  }

  async getUiSettings() {
    const settings = this.#context.readSettings();
    return settings.ui || {};
  }

  async setUiSettings(patch) {
    return this.#context.mutate(async () => {
      const settings = this.#context.readSettings();
      settings.ui = normalizeUiSettings({ ...(settings.ui || {}), ...patch });
      bumpRemoteSettingsVersion(settings);
      await this.#context.saveAndMaybeEmitRemote(settings, true);
      return settings.ui;
    });
  }

  async getPathSettings() {
    const settings = this.#context.readSettings();
    return settings.paths || {};
  }

  async setPathSettings(patch) {
    return this.#context.mutate(async () => {
      const settings = this.#context.readSettings();
      settings.paths = { ...(settings.paths || {}), ...patch };
      bumpRemoteSettingsVersion(settings);
      await this.#context.saveAndMaybeEmitRemote(settings, true);
      return settings.paths;
    });
  }

  async getRemoteSettingsVersion() {
    const settings = this.#context.readSettings();
    return normalizeRemoteSettingsVersion(settings.remoteSettingsVersion);
  }

  async getRemoteSettingsSnapshotSource() {
    const settings = this.#context.readSettings();
    return {
      version: normalizeRemoteSettingsVersion(settings.remoteSettingsVersion),
      ui: settings.ui || {},
      paths: settings.paths || {},
      pinnedChatIds: settings.pinnedChatIds || [],
      lastAgentId: settings.lastAgentId || 'claude',
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
}

export class LastChatDefaultsStore {
  #context;

  constructor(context) {
    this.#context = context;
  }

  async getLastPermissionMode() {
    const settings = this.#context.readSettings();
    return normalizePermissionMode(settings.lastPermissionMode);
  }

  async getLastAgentId() {
    const settings = this.#context.readSettings();
    return settings.lastAgentId || 'claude';
  }

  async getLastProjectPath() {
    const settings = this.#context.readSettings();
    return settings.lastProjectPath || '';
  }

  async getLastModel() {
    const settings = this.#context.readSettings();
    return settings.lastModel || '';
  }

  async getLastApiProviderId() {
    const settings = this.#context.readSettings();
    return settings.lastApiProviderId ?? null;
  }

  async getLastModelEndpointId() {
    const settings = this.#context.readSettings();
    return settings.lastModelEndpointId ?? null;
  }

  async getLastModelProtocol() {
    const settings = this.#context.readSettings();
    return settings.lastModelProtocol ?? null;
  }

  async setLastChatDefaults(defaults) {
    return this.#context.mutate(async () => {
      const settings = this.#context.readSettings();
      settings.lastAgentId = typeof defaults?.agentId === 'string'
        ? defaults.agentId
        : (settings.lastAgentId || 'claude');
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
      await this.#context.saveAndMaybeEmitRemote(settings, true);
    });
  }

  async setLastPermissionMode(mode) {
    return this.setLastChatDefaults({ permissionMode: mode });
  }

  async getLastThinkingMode() {
    const settings = this.#context.readSettings();
    return normalizeThinkingMode(settings.lastThinkingMode);
  }

  async setLastThinkingMode(mode) {
    return this.setLastChatDefaults({ thinkingMode: mode });
  }

  async getLastClaudeThinkingMode() {
    const settings = this.#context.readSettings();
    return normalizeClaudeThinkingMode(settings.lastClaudeThinkingMode);
  }

  async setLastClaudeThinkingMode(mode) {
    return this.setLastChatDefaults({ claudeThinkingMode: mode });
  }

  async getLastAmpAgentMode() {
    const settings = this.#context.readSettings();
    return normalizeAmpAgentMode(settings.lastAmpAgentMode);
  }

  async setLastAmpAgentMode(mode) {
    return this.setLastChatDefaults({ ampAgentMode: mode });
  }
}

export class ChatOrderStore {
  #context;

  constructor(context) {
    this.#context = context;
  }

  async reconcileWithRegistry(registry) {
    return this.#context.mutate(async () => {
      const sessions = registry.listAllChats();
      const allChatIds = new Set(Object.keys(sessions));
      const currentSettings = this.#context.readSettings();
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
        bumpRemoteSettingsVersionForPinnedChange(currentSettings, beforePinned);
        await this.#context.save(currentSettings);
      }
    });
  }

  async getPinnedChatIds() {
    const settings = this.#context.readSettings();
    return settings.pinnedChatIds || [];
  }

  async getArchivedChatIds() {
    const settings = this.#context.readSettings();
    return settings.archivedChatIds || [];
  }

  async getNormalChatIds() {
    const settings = this.#context.readSettings();
    return settings.normalChatIds || [];
  }

  async ensureInNormal(chatId) {
    return this.#context.mutate(async () => {
      const settings = this.#context.readSettings();
      const beforePinned = dedup(settings.pinnedChatIds || []);
      for (const key of ['pinnedChatIds', 'normalChatIds', 'archivedChatIds']) {
        const ids = settings[key] || [];
        if (ids.includes(chatId)) {
          settings[key] = ids.filter((id) => id !== chatId);
        }
      }
      settings.normalChatIds = [chatId, ...(settings.normalChatIds || [])];
      const pinnedChanged = bumpRemoteSettingsVersionForPinnedChange(settings, beforePinned);
      await this.#context.saveAndMaybeEmitRemote(settings, pinnedChanged);
      this.#context.emitListChanged('chat-added', chatId);
    });
  }

  async insertNormalChatIdTop(chatId) {
    return this.#context.mutate(async () => {
      const settings = this.#context.readSettings();
      const ids = (settings.normalChatIds || []).filter((id) => id !== chatId);
      settings.normalChatIds = [chatId, ...ids];
      await this.#context.save(settings);
    });
  }

  async removeFromAllOrderLists(chatId) {
    return this.#context.mutate(async () => {
      const settings = this.#context.readSettings();
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

      const pinnedChanged = bumpRemoteSettingsVersionForPinnedChange(settings, beforePinned);
      await this.#context.saveAndMaybeEmitRemote(settings, pinnedChanged);
    });
  }

  async togglePin(chatId) {
    return this.#context.mutate(async () => {
      const s = this.#context.readSettings();
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
      await this.#context.saveAndMaybeEmitRemote(s, true);
      this.#context.emitListChanged('pinned-toggled', chatId);
      return { isPinned: !isPinned };
    });
  }

  async toggleArchive(chatId) {
    return this.#context.mutate(async () => {
      const s = this.#context.readSettings();
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

      const pinnedChanged = bumpRemoteSettingsVersionForPinnedChange(s, beforePinned);
      await this.#context.saveAndMaybeEmitRemote(s, pinnedChanged);
      this.#context.emitListChanged('archive-toggled', chatId);
      return { isArchived: !isArchived };
    });
  }

  async reorderWindow(list, rawOldOrder, rawNewOrder) {
    const validation = validateWindowReorder(rawOldOrder, rawNewOrder);
    if (!validation.success) return validation;
    const { oldOrder, newOrder } = validation;

    return this.#context.mutate(async () => {
      const s = this.#context.readSettings();
      const key = list === 'pinned' ? 'pinnedChatIds' : list === 'archived' ? 'archivedChatIds' : 'normalChatIds';
      const current = dedup(s[key] || []);

      const currentSet = new Set(current);
      for (const id of oldOrder) {
        if (!currentSet.has(id)) return { success: false, error: `ID "${id}" is not in the ${list} list` };
      }

      const result = applyWindowReorder(current, oldOrder, newOrder);
      if (!result) return { success: false, error: 'oldOrder is not a contiguous subsequence of the current list' };

      s[key] = result;
      const remoteSettingsChanged = list === 'pinned';
      if (remoteSettingsChanged) {
        bumpRemoteSettingsVersion(s);
      }
      await this.#context.saveAndMaybeEmitRemote(s, remoteSettingsChanged);

      const anchorChatId = newOrder[0] || list;
      this.#context.emitListChanged('chats-reordered', anchorChatId);
      return { success: true };
    });
  }

  async reorderRelative(chatId, refId, mode) {
    return this.#context.mutate(async () => {
      const s = this.#context.readSettings();
      const chatGroup = resolveGroupInSettings(s, chatId);
      const refGroup = resolveGroupInSettings(s, refId);

      if (!chatGroup || !refGroup) return { success: false, error: 'Chat not found in any order list' };
      if (chatGroup.group !== refGroup.group) return { success: false, error: 'Cross-group reorder is not allowed' };

      const result = moveRelative(chatGroup.list, chatId, refId, mode);
      if (!result) return { success: false, error: 'Chat positions could not be resolved' };

      s[chatGroup.key] = result;
      const remoteSettingsChanged = chatGroup.group === 'pinned';
      if (remoteSettingsChanged) {
        bumpRemoteSettingsVersion(s);
      }
      await this.#context.saveAndMaybeEmitRemote(s, remoteSettingsChanged);
      this.#context.emitListChanged('chats-reordered-quick', chatId);
      return { success: true };
    });
  }
}

export class SavedSearchStore {
  #context;

  constructor(context) {
    this.#context = context;
  }

  async getSavedSearches() {
    const settings = this.#context.readSettings();
    return settings.savedChatSearches || [];
  }

  async addSavedSearch(savedSearch) {
    return this.#context.mutate(async () => {
      const s = this.#context.readSettings();
      const searches = s.savedChatSearches || [];
      if (searches.some((entry) => entry.id === savedSearch.id)) {
        throw new Error(`Saved search with ID ${savedSearch.id} already exists`);
      }
      s.savedChatSearches = [...searches, savedSearch];
      await this.#context.save(s);
      return savedSearch;
    });
  }

  async updateSavedSearch(searchId, patch) {
    return this.#context.mutate(async () => {
      const s = this.#context.readSettings();
      const searches = s.savedChatSearches || [];
      const idx = searches.findIndex((entry) => entry.id === searchId);
      if (idx < 0) {
        throw new Error(`Saved search not found: ${searchId}`);
      }
      searches[idx] = { ...searches[idx], ...patch };
      s.savedChatSearches = searches;
      await this.#context.save(s);
      return searches[idx];
    });
  }

  async removeSavedSearch(searchId) {
    return this.#context.mutate(async () => {
      const s = this.#context.readSettings();
      const searches = s.savedChatSearches || [];
      const idx = searches.findIndex((entry) => entry.id === searchId);
      if (idx < 0) return false;
      s.savedChatSearches = searches.filter((entry) => entry.id !== searchId);
      await this.#context.save(s);
      return true;
    });
  }

  async reorderSavedSearches(oldOrder, newOrder) {
    const validation = validateWindowReorder(oldOrder, newOrder);
    if (!validation.success) return validation;

    return this.#context.mutate(async () => {
      const s = this.#context.readSettings();
      const searches = s.savedChatSearches || [];
      const currentIds = searches.map((entry) => entry.id);

      const result = applyWindowReorder(currentIds, validation.oldOrder, validation.newOrder);
      if (!result) return { success: false, error: 'oldOrder is not a contiguous subsequence of the current list' };

      const byId = new Map(searches.map((entry) => [entry.id, entry]));
      s.savedChatSearches = result.map((id) => byId.get(id)).filter(Boolean);
      await this.#context.save(s);
      return { success: true };
    });
  }
}

export class FolderStore {
  #context;

  constructor(context) {
    this.#context = context;
  }

  async getFolders() {
    const settings = this.#context.readSettings();
    return settings.chatFolders || [];
  }

  async addFolder(folder) {
    return this.#context.mutate(async () => {
      const s = this.#context.readSettings();
      const folders = s.chatFolders || [];
      if (folders.some((f) => f.id === folder.id)) {
        throw new Error(`Folder with ID ${folder.id} already exists`);
      }
      s.chatFolders = [...folders, folder];
      await this.#context.save(s);
      return folder;
    });
  }

  async updateFolder(folderId, patch) {
    return this.#context.mutate(async () => {
      const s = this.#context.readSettings();
      const folders = s.chatFolders || [];
      const idx = folders.findIndex((f) => f.id === folderId);
      if (idx < 0) {
        throw new Error(`Folder not found: ${folderId}`);
      }
      folders[idx] = { ...folders[idx], ...patch };
      s.chatFolders = folders;
      await this.#context.save(s);
      return folders[idx];
    });
  }

  async removeFolder(folderId) {
    return this.#context.mutate(async () => {
      const s = this.#context.readSettings();
      const folders = s.chatFolders || [];
      const idx = folders.findIndex((f) => f.id === folderId);
      if (idx < 0) return false;
      s.chatFolders = folders.filter((f) => f.id !== folderId);
      await this.#context.save(s);
      return true;
    });
  }
}
