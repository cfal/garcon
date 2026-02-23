// App settings persistence (project-settings.json). Manages ui preferences,
// path settings, chat-scoped session name overrides, and ordering lists.
// Maintains an in-memory #cache for getChatName() reads; high-level
// mutations always call loadSettings() then saveSettings() which keeps
// the cache in sync via identity sharing.

import { promises as fs } from 'fs';
import path from 'path';
import { EventEmitter } from 'events';

function createEmpty() {
  return { ui: {}, paths: {}, chatNames: {}, pinnedChatIds: [], normalChatIds: [], archivedChatIds: [], lastPermissionMode: 'default', lastThinkingMode: 'none' };
}

function sanitize(parsed) {
  return {
    ui: parsed.ui && typeof parsed.ui === 'object' ? parsed.ui : {},
    paths: parsed.paths && typeof parsed.paths === 'object' ? parsed.paths : {},
    chatNames: parsed.chatNames && typeof parsed.chatNames === 'object' ? parsed.chatNames : {},
    pinnedChatIds: Array.isArray(parsed.pinnedChatIds) ? parsed.pinnedChatIds : [],
    normalChatIds: Array.isArray(parsed.normalChatIds) ? parsed.normalChatIds : [],
    archivedChatIds: Array.isArray(parsed.archivedChatIds) ? parsed.archivedChatIds : [],
    lastPermissionMode: typeof parsed.lastPermissionMode === 'string' ? parsed.lastPermissionMode : 'default',
    lastThinkingMode: typeof parsed.lastThinkingMode === 'string' ? parsed.lastThinkingMode : 'none',
  };
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
      settings.ui = { ...(settings.ui || {}), ...patch };
      await this.saveSettings(settings);
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
      await this.saveSettings(settings);
      return settings.paths;
    });
  }

  async getPinnedChatIds() {
    const settings = await this.loadSettings();
    return settings.pinnedChatIds || [];
  }

  async getArchivedChatIds() {
    const settings = await this.loadSettings();
    return settings.archivedChatIds || [];
  }

  async getLastPermissionMode() {
    const settings = await this.loadSettings();
    return settings.lastPermissionMode || 'default';
  }

  async setLastPermissionMode(mode) {
    return this.#withLock(async () => {
      const settings = await this.loadSettings();
      settings.lastPermissionMode = typeof mode === 'string' ? mode : 'default';
      await this.saveSettings(settings);
    });
  }

  async getLastThinkingMode() {
    const settings = await this.loadSettings();
    return settings.lastThinkingMode || 'none';
  }

  async setLastThinkingMode(mode) {
    return this.#withLock(async () => {
      const settings = await this.loadSettings();
      settings.lastThinkingMode = typeof mode === 'string' ? mode : 'none';
      await this.saveSettings(settings);
    });
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
      for (const key of ['pinnedChatIds', 'normalChatIds', 'archivedChatIds']) {
        const ids = settings[key] || [];
        if (ids.includes(chatId)) {
          settings[key] = ids.filter((id) => id !== chatId);
        }
      }
      settings.normalChatIds = [chatId, ...(settings.normalChatIds || [])];
      await this.saveSettings(settings);
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
      let dirty = false;
      for (const key of ['pinnedChatIds', 'normalChatIds', 'archivedChatIds']) {
        const ids = settings[key] || [];
        if (ids.includes(chatId)) {
          settings[key] = ids.filter((id) => id !== chatId);
          dirty = true;
        }
      }
      if (dirty) await this.saveSettings(settings);
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

      await this.saveSettings(s);
      this.emitListChanged('pinned-toggled', chatId);
      return { isPinned: !isPinned };
    });
  }

  // Toggles archive state for a chat in a single disk round-trip.
  async toggleArchive(chatId) {
    return this.#withLock(async () => {
      const s = await this.loadSettings();
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

      await this.saveSettings(s);
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
      await this.saveSettings(s);

      const anchorChatId = normNew[0] || list;
      this.emitListChanged('chats-reordered', anchorChatId);
      return { success: true };
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
      await this.saveSettings(s);
      this.emitListChanged('chats-reordered-quick', chatId);
      return { success: true };
    });
  }
}
