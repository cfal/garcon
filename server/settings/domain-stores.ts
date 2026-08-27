import type { IChatRegistry } from '../chats/store.js';
import { createLogger } from '../lib/log.js';

const logger = createLogger('settings:domain-stores');
import {
  DEFAULT_REMOTE_FEATURE_SETTINGS,
  normalizeRemoteFeatureSettings,
} from '../../common/settings.js';
import type {
  PersistedChatOrderGroup,
  ReorderChatRequest,
  ReorderChatResponse,
} from '../../common/chat-order-contracts.js';
import {
  normalizeRemoteSettingsVersion,
  normalizeUiSettings,
} from './settings-shared.js';
import type {
  ChatFolder,
  ChatReorderResult,
  ExecutionDefaults,
  ProjectSettings,
  ReorderResult,
  SavedChatSearch,
  SettingsStoreContext,
  WindowReorderValidation,
} from './types.js';
import {
  dedupeRecentAgentSettings,
  normalizePathSettings,
  recordRecentProjectPath,
  sanitizeExecutionDefaults,
  sanitizeExecutionDefaultsSettings,
  sanitizeRecentAgentSetting,
} from './startup-recents.js';
import {
  FolderAlreadyExistsError,
  FolderNotFoundError,
  SavedSearchAlreadyExistsError,
  SavedSearchNotFoundError,
} from './errors.js';

const ORDER_LIST_KEYS = ['pinnedChatIds', 'normalChatIds', 'archivedChatIds'] as const;

type OrderListKey = typeof ORDER_LIST_KEYS[number];
type ChatOrderSnapshot = Record<OrderListKey, string[]>;

const ORDER_GROUP_KEYS: Record<PersistedChatOrderGroup, OrderListKey> = {
  pinned: 'pinnedChatIds',
  normal: 'normalChatIds',
  archived: 'archivedChatIds',
};

function bumpRemoteSettingsVersion(settings: ProjectSettings): void {
  settings.remoteSettingsVersion = normalizeRemoteSettingsVersion(settings.remoteSettingsVersion) + 1;
}

function sameOrderedStringArray(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function bumpRemoteSettingsVersionForPinnedChange(settings: ProjectSettings, beforePinned: string[]): boolean {
  const afterPinned = dedup(settings.pinnedChatIds || []);
  const changed = !sameOrderedStringArray(beforePinned, afterPinned);
  if (changed) {
    bumpRemoteSettingsVersion(settings);
  }
  return changed;
}

function dedup(ids: unknown): string[] {
  if (!Array.isArray(ids)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of ids) {
    if (typeof raw !== 'string') continue;
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function findWindowIndex(full: string[], windowIds: string[]): number {
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

function applyWindowReorder(full: string[], oldOrder: string[], newOrder: string[]): string[] | null {
  const at = findWindowIndex(full, oldOrder);
  if (at < 0) return null;
  return [...full.slice(0, at), ...newOrder, ...full.slice(at + oldOrder.length)];
}

function validateWindowReorder(rawOldOrder: unknown, rawNewOrder: unknown): WindowReorderValidation {
  const oldOrder = dedup(rawOldOrder);
  const newOrder = dedup(rawNewOrder);

  if (oldOrder.length === 0) {
    return { success: false, error: 'oldOrder must not be empty', errorCode: 'ORDER_INVALID_INPUT', status: 400 };
  }
  if (oldOrder.length !== newOrder.length) {
    return {
      success: false,
      error: 'oldOrder and newOrder must have the same length',
      errorCode: 'ORDER_INVALID_INPUT',
      status: 400,
    };
  }

  const oldSet = new Set(oldOrder);
  const newSet = new Set(newOrder);
  if (oldOrder.length !== oldSet.size || newOrder.length !== newSet.size) {
    return {
      success: false,
      error: 'oldOrder and newOrder must contain unique IDs',
      errorCode: 'ORDER_INVALID_INPUT',
      status: 400,
    };
  }
  for (const id of newOrder) {
    if (!oldSet.has(id)) {
      return {
        success: false,
        error: 'oldOrder and newOrder must contain the same IDs',
        errorCode: 'ORDER_INVALID_INPUT',
        status: 400,
      };
    }
  }

  return { success: true, oldOrder, newOrder };
}

function orderSnapshot(settings: ProjectSettings): ChatOrderSnapshot {
  return {
    pinnedChatIds: [...(settings.pinnedChatIds || [])],
    normalChatIds: [...(settings.normalChatIds || [])],
    archivedChatIds: [...(settings.archivedChatIds || [])],
  };
}

function restoreOrderSnapshot(settings: ProjectSettings, snapshot: ChatOrderSnapshot): void {
  for (const key of ORDER_LIST_KEYS) settings[key] = [...snapshot[key]];
}

function sameOrderSnapshot(left: ChatOrderSnapshot, right: ChatOrderSnapshot): boolean {
  return ORDER_LIST_KEYS.every((key) => sameOrderedStringArray(left[key], right[key]));
}

function resolveOrReconcileGroup(
  settings: ProjectSettings,
  chatId: string,
): PersistedChatOrderGroup {
  if (settings.pinnedChatIds.includes(chatId)) return 'pinned';
  if (settings.normalChatIds.includes(chatId)) return 'normal';
  if (settings.archivedChatIds.includes(chatId)) return 'archived';
  settings.normalChatIds.push(chatId);
  return 'normal';
}

function removeFromEveryOrderGroup(settings: ProjectSettings, chatId: string): void {
  for (const key of ORDER_LIST_KEYS) {
    settings[key] = dedup(settings[key]).filter((id) => id !== chatId);
  }
}

function sessionNotFound(error: string): ChatReorderResult {
  return {
    success: false,
    error,
    errorCode: 'SESSION_NOT_FOUND',
    status: 404,
  };
}

export class ChatNameStore {
  #context: SettingsStoreContext;

  constructor(context: SettingsStoreContext) {
    this.#context = context;
  }

  getChatName(chatId: string): string | null {
    const settings = this.#context.readSettings();
    if (!chatId) return null;
    if (!settings.chatNames) return null;
    return settings.chatNames[chatId] ?? null;
  }

  async #persistSessionName(
    settings: ProjectSettings,
    chatId: string,
    title: string,
  ): Promise<void> {
    if (!settings.chatNames) settings.chatNames = {};
    const trimmed = typeof title === 'string' ? title.trim() : '';
    if (!trimmed) {
      delete settings.chatNames[String(chatId)];
    } else {
      settings.chatNames[String(chatId)] = trimmed;
    }
    await this.#context.save(settings);
    this.#context.emitSessionNameChanged(chatId, trimmed || '');
  }

  async setSessionName(chatId: string, title: string): Promise<void> {
    return this.#context.mutate(async () => {
      const settings = this.#context.readSettings();
      await this.#persistSessionName(settings, chatId, title);
    });
  }

  async setSessionNameIfAbsent(chatId: string, title: string): Promise<boolean> {
    return this.#context.mutate(async () => {
      const settings = this.#context.readSettings();
      if (settings.chatNames?.[String(chatId)]) return false;
      await this.#persistSessionName(settings, chatId, title);
      return true;
    });
  }

  async removeSessionName(chatId: string): Promise<void> {
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
  #context: SettingsStoreContext;

  constructor(context: SettingsStoreContext) {
    this.#context = context;
  }

  getUiSettings(): ProjectSettings['ui'] {
    const settings = this.#context.readSettings();
    return normalizeUiSettings(settings.ui || {});
  }

  async setUiSettings(patch: Record<string, unknown>): Promise<ProjectSettings['ui']> {
    return this.#context.mutate(async () => {
      const settings = this.#context.readSettings();
      settings.ui = normalizeUiSettings({ ...(settings.ui || {}), ...patch });
      bumpRemoteSettingsVersion(settings);
      await this.#context.saveAndMaybeEmitRemote(settings, true);
      return settings.ui;
    });
  }

  getPathSettings(): ProjectSettings['paths'] {
    const settings = this.#context.readSettings();
    return settings.paths || {};
  }

  async setPathSettings(patch: Record<string, unknown>): Promise<ProjectSettings['paths']> {
    return this.#context.mutate(async () => {
      const settings = this.#context.readSettings();
      settings.paths = normalizePathSettings({ ...(settings.paths || {}), ...patch });
      bumpRemoteSettingsVersion(settings);
      await this.#context.saveAndMaybeEmitRemote(settings, true);
      return settings.paths;
    });
  }

  getRemoteSettingsVersion(): number {
    const settings = this.#context.readSettings();
    return normalizeRemoteSettingsVersion(settings.remoteSettingsVersion);
  }

  getRemoteSettingsSnapshotSource(): {
    version: number;
    ui: ProjectSettings['ui'];
    paths: ProjectSettings['paths'];
    pinnedChatIds: string[];
    recentAgentSettings: ProjectSettings['recentAgentSettings'];
    executionDefaults: ProjectSettings['executionDefaults'];
  } {
    const settings = this.#context.readSettings();
    const executionDefaults = sanitizeExecutionDefaultsSettings(settings.executionDefaults).defaults;
    return {
      version: normalizeRemoteSettingsVersion(settings.remoteSettingsVersion),
      ui: normalizeUiSettings(settings.ui || {}),
      paths: settings.paths || {},
      pinnedChatIds: settings.pinnedChatIds || [],
      recentAgentSettings: settings.recentAgentSettings || [],
      executionDefaults,
    };
  }
}

export class FeatureSettingsStore {
  #context: SettingsStoreContext;

  constructor(context: SettingsStoreContext) {
    this.#context = context;
  }

  getFeatureSettings(): ProjectSettings['features'] {
    const features = normalizeRemoteFeatureSettings(
      this.#context.readSettings().features ?? DEFAULT_REMOTE_FEATURE_SETTINGS,
    );
    return structuredClone(features);
  }

  async setTranscriptSearchEnabled(enabled: boolean): Promise<ProjectSettings['features']> {
    return this.#context.mutate(async () => {
      const settings = this.#context.readSettings();
      settings.features = {
        ...normalizeRemoteFeatureSettings(settings.features),
        transcriptSearch: { enabled },
      };
      bumpRemoteSettingsVersion(settings);
      await this.#context.saveAndMaybeEmitRemote(settings, true);
      return structuredClone(settings.features);
    });
  }

  async setChatIdDiscoveryEnabled(enabled: boolean): Promise<ProjectSettings['features']> {
    return this.#context.mutate(async () => {
      const settings = this.#context.readSettings();
      settings.features = {
        ...normalizeRemoteFeatureSettings(settings.features),
        chatIdDiscovery: { enabled },
      };
      bumpRemoteSettingsVersion(settings);
      await this.#context.saveAndMaybeEmitRemote(settings, true);
      return structuredClone(settings.features);
    });
  }
}

export class StartupDefaultsStore {
  #context: SettingsStoreContext;

  constructor(context: SettingsStoreContext) {
    this.#context = context;
  }

  getRecentAgentSettings(): ProjectSettings['recentAgentSettings'] {
    const settings = this.#context.readSettings();
    return settings.recentAgentSettings || [];
  }

  getRecentProjectPaths(): string[] {
    const settings = this.#context.readSettings();
    const paths = settings.paths || {};
    return Array.isArray(paths.recentProjectPaths)
      ? paths.recentProjectPaths.filter((entry): entry is string => typeof entry === 'string')
      : [];
  }

  getExecutionDefaults(): ProjectSettings['executionDefaults'] {
    const settings = this.#context.readSettings();
    return sanitizeExecutionDefaultsSettings(settings.executionDefaults).defaults;
  }

  async recordChatStartup(defaults: Record<string, unknown> | null | undefined): Promise<void> {
    return this.#context.mutate(async () => {
      const settings = this.#context.readSettings();

      const recent = sanitizeRecentAgentSetting(defaults);
      if (recent) {
        settings.recentAgentSettings = dedupeRecentAgentSettings([
          recent,
          ...(settings.recentAgentSettings || []),
        ]);
      }

      settings.paths = recordRecentProjectPath(settings.paths || {}, defaults?.projectPath);

      const agentId = typeof defaults?.agentId === 'string' ? defaults.agentId.trim() : recent?.agentId ?? '';
      if (agentId) {
        const current = sanitizeExecutionDefaultsSettings(settings.executionDefaults).defaults;
        settings.executionDefaults = {
          ...current,
          byAgent: {
            ...current.byAgent,
            [agentId]: sanitizeExecutionDefaults(defaults),
          },
        };
      }

      bumpRemoteSettingsVersion(settings);
      await this.#context.saveAndMaybeEmitRemote(settings, true);
    });
  }

  async updateExecutionDefaultsForAgent(
    agentId: string,
    patch: Partial<ExecutionDefaults>,
  ): Promise<void> {
    const trimmedAgentId = agentId.trim();
    if (!trimmedAgentId) return;

    return this.#context.mutate(async () => {
      const settings = this.#context.readSettings();
      const current = sanitizeExecutionDefaultsSettings(settings.executionDefaults).defaults;
      const merged = sanitizeExecutionDefaults({
        ...current.global,
        ...(current.byAgent[trimmedAgentId] ?? {}),
        ...patch,
      });

      settings.executionDefaults = {
        ...current,
        byAgent: {
          ...current.byAgent,
          [trimmedAgentId]: merged,
        },
      };
      bumpRemoteSettingsVersion(settings);
      await this.#context.saveAndMaybeEmitRemote(settings, true);
    });
  }
}

export class ChatOrderStore {
  #context: SettingsStoreContext;

  constructor(context: SettingsStoreContext) {
    this.#context = context;
  }

  async reconcileWithRegistry(registry: IChatRegistry): Promise<void> {
    return this.#context.mutate(async () => {
      const sessions = registry.listAllChats();
      const allChatIds = new Set(Object.keys(sessions));
      const currentSettings = this.#context.readSettings();
      const beforePinned = dedup(currentSettings.pinnedChatIds || []);

      let pinned = dedup(currentSettings.pinnedChatIds || []);
      let normal = dedup(currentSettings.normalChatIds || []);
      let archived = dedup(currentSettings.archivedChatIds || []);

      let dirty = false;

      const filterUnknown = (list: string[], name: string): string[] => {
        const unknown = list.filter((id) => !allChatIds.has(id));
        if (unknown.length > 0) {
          logger.info(`chat-order: removed unknown chat IDs from ${name}: ${JSON.stringify(unknown)}`);
          dirty = true;
          return list.filter((id) => allChatIds.has(id));
        }
        return list;
      };

      pinned = filterUnknown(pinned, 'pinnedChatIds');
      normal = filterUnknown(normal, 'normalChatIds');
      archived = filterUnknown(archived, 'archivedChatIds');

      const claimed = new Set<string>();
      const dedupeAcross = (list: string[], name: string): string[] => {
        const dupes: string[] = [];
        const kept: string[] = [];
        for (const id of list) {
          if (claimed.has(id)) {
            dupes.push(id);
          } else {
            claimed.add(id);
            kept.push(id);
          }
        }
        if (dupes.length > 0) {
          logger.info(`chat-order: removed duplicate chat IDs from ${name}: ${JSON.stringify(dupes)}`);
          dirty = true;
        }
        return kept;
      };

      pinned = dedupeAcross(pinned, 'pinnedChatIds');
      normal = dedupeAcross(normal, 'normalChatIds');
      archived = dedupeAcross(archived, 'archivedChatIds');

      const union = new Set([...pinned, ...normal, ...archived]);
      const missing: string[] = [];
      for (const id of allChatIds) {
        if (!union.has(id)) missing.push(id);
      }
      if (missing.length > 0) {
        missing.sort((a, b) => {
          if (a.length !== b.length) return b.length - a.length;
          return b.localeCompare(a);
        });
        normal = [...missing, ...normal];
        logger.info(`chat-order: added missing chat IDs to normalChatIds: ${JSON.stringify(missing)}`);
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

  getPinnedChatIds(): string[] {
    const settings = this.#context.readSettings();
    return settings.pinnedChatIds || [];
  }

  getArchivedChatIds(): string[] {
    const settings = this.#context.readSettings();
    return settings.archivedChatIds || [];
  }

  getNormalChatIds(): string[] {
    const settings = this.#context.readSettings();
    return settings.normalChatIds || [];
  }

  async ensureInNormal(chatId: string): Promise<void> {
    return this.#context.mutate(async () => {
      const settings = this.#context.readSettings();
      const beforePinned = dedup(settings.pinnedChatIds || []);
      for (const key of ORDER_LIST_KEYS) {
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

  async insertNormalChatIdTop(chatId: string): Promise<void> {
    return this.#context.mutate(async () => {
      const settings = this.#context.readSettings();
      const ids = (settings.normalChatIds || []).filter((id) => id !== chatId);
      settings.normalChatIds = [chatId, ...ids];
      await this.#context.save(settings);
    });
  }

  async removeFromAllOrderLists(chatId: string): Promise<void> {
    return this.#context.mutate(async () => {
      const settings = this.#context.readSettings();
      const beforePinned = dedup(settings.pinnedChatIds || []);
      let dirty = false;
      for (const key of ORDER_LIST_KEYS) {
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

  async togglePin(chatId: string): Promise<{ isPinned: boolean }> {
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

  async toggleArchive(chatId: string): Promise<{ isArchived: boolean }> {
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

  async reorderChat(
    request: ReorderChatRequest,
    isKnownChat: (chatId: string) => boolean,
  ): Promise<ChatReorderResult> {
    return this.#context.mutate(async () => {
      const settings = this.#context.readSettings();
      if (!isKnownChat(request.chatId)) return sessionNotFound('Chat not found');
      if (
        request.placement.kind === 'relative'
        && !isKnownChat(request.placement.referenceChatId)
      ) {
        return sessionNotFound('Reference chat not found');
      }

      const before = orderSnapshot(settings);
      const sourceGroup = resolveOrReconcileGroup(settings, request.chatId);
      if (request.placement.kind === 'relative') {
        const referenceGroup = resolveOrReconcileGroup(
          settings,
          request.placement.referenceChatId,
        );
        if (sourceGroup !== referenceGroup) {
          restoreOrderSnapshot(settings, before);
          return {
            success: false,
            error: 'Cross-group reorder is not allowed',
            errorCode: 'ORDER_CROSS_GROUP',
            status: 400,
          };
        }
      }

      removeFromEveryOrderGroup(settings, request.chatId);
      const target = settings[ORDER_GROUP_KEYS[sourceGroup]];
      if (request.placement.kind === 'boundary') {
        const index = request.placement.boundary === 'top' ? 0 : target.length;
        target.splice(index, 0, request.chatId);
      } else {
        const referenceIndex = target.indexOf(request.placement.referenceChatId);
        if (referenceIndex < 0) {
          throw new Error('Resolved reorder reference is absent');
        }
        const index = request.placement.position === 'before'
          ? referenceIndex
          : referenceIndex + 1;
        target.splice(index, 0, request.chatId);
      }

      const response: ReorderChatResponse = {
        success: true,
        chatId: request.chatId,
        orderGroup: sourceGroup,
        changed: !sameOrderSnapshot(before, orderSnapshot(settings)),
      };
      if (!response.changed) {
        return { success: true, response };
      }

      const remoteSettingsChanged = bumpRemoteSettingsVersionForPinnedChange(
        settings,
        before.pinnedChatIds,
      );
      await this.#context.saveAndMaybeEmitRemote(settings, remoteSettingsChanged);
      this.#context.emitListChanged('chats-reordered', request.chatId);
      return { success: true, response };
    });
  }
}

export class SavedSearchStore {
  #context: SettingsStoreContext;

  constructor(context: SettingsStoreContext) {
    this.#context = context;
  }

  getSavedSearches(): SavedChatSearch[] {
    const settings = this.#context.readSettings();
    return settings.savedChatSearches || [];
  }

  async addSavedSearch(savedSearch: SavedChatSearch): Promise<SavedChatSearch> {
    return this.#context.mutate(async () => {
      const s = this.#context.readSettings();
      const searches = s.savedChatSearches || [];
      if (searches.some((entry) => entry.id === savedSearch.id)) {
        throw new SavedSearchAlreadyExistsError(savedSearch.id);
      }
      s.savedChatSearches = [...searches, savedSearch];
      await this.#context.save(s);
      return savedSearch;
    });
  }

  async updateSavedSearch(searchId: string, patch: Partial<SavedChatSearch>): Promise<SavedChatSearch> {
    return this.#context.mutate(async () => {
      const s = this.#context.readSettings();
      const searches = s.savedChatSearches || [];
      const idx = searches.findIndex((entry) => entry.id === searchId);
      if (idx < 0) {
        throw new SavedSearchNotFoundError(searchId);
      }
      searches[idx] = { ...searches[idx], ...patch };
      s.savedChatSearches = searches;
      await this.#context.save(s);
      return searches[idx];
    });
  }

  async removeSavedSearch(searchId: string): Promise<boolean> {
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

  async reorderSavedSearches(oldOrder: unknown, newOrder: unknown): Promise<ReorderResult> {
    const validation = validateWindowReorder(oldOrder, newOrder);
    if (!validation.success) return validation;

    return this.#context.mutate(async () => {
      const s = this.#context.readSettings();
      const searches = s.savedChatSearches || [];
      const currentIds = searches.map((entry) => entry.id);

      const result = applyWindowReorder(currentIds, validation.oldOrder, validation.newOrder);
      if (!result) {
        return {
          success: false,
          error: 'oldOrder is not a contiguous subsequence of the current list',
          errorCode: 'ORDER_INVALID_INPUT',
          status: 400,
        };
      }

      const byId = new Map(searches.map((entry) => [entry.id, entry]));
      s.savedChatSearches = result.map((id) => byId.get(id)).filter((entry): entry is SavedChatSearch => Boolean(entry));
      await this.#context.save(s);
      return { success: true };
    });
  }
}

export class FolderStore {
  #context: SettingsStoreContext;

  constructor(context: SettingsStoreContext) {
    this.#context = context;
  }

  getFolders(): ChatFolder[] {
    const settings = this.#context.readSettings();
    return settings.chatFolders || [];
  }

  async addFolder(folder: ChatFolder): Promise<ChatFolder> {
    return this.#context.mutate(async () => {
      const s = this.#context.readSettings();
      const folders = s.chatFolders || [];
      if (folders.some((f) => f.id === folder.id)) {
        throw new FolderAlreadyExistsError(folder.id);
      }
      s.chatFolders = [...folders, folder];
      await this.#context.save(s);
      return folder;
    });
  }

  async updateFolder(folderId: string, patch: Partial<ChatFolder>): Promise<ChatFolder> {
    return this.#context.mutate(async () => {
      const s = this.#context.readSettings();
      const folders = s.chatFolders || [];
      const idx = folders.findIndex((f) => f.id === folderId);
      if (idx < 0) {
        throw new FolderNotFoundError(folderId);
      }
      folders[idx] = { ...folders[idx], ...patch };
      s.chatFolders = folders;
      await this.#context.save(s);
      return folders[idx];
    });
  }

  async removeFolder(folderId: string): Promise<boolean> {
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
