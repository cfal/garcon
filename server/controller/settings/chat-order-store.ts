import type {
  PersistedChatOrderGroup,
  ReorderChatRequest,
  ReorderChatResponse,
  SetChatOrderStateResponse,
} from '../../../common/chat-order-contracts.js';
import type { ChatOrderIdComparator } from '../../../common/chat-order-sort.js';
import { createLogger } from '../../common/log.js';
import type { IChatRegistry } from '../chats/store.js';
import { dedup } from './order-helpers.js';
import { bumpRemoteSettingsVersion } from './settings-shared.js';
import type {
  ChatOrderComparatorOverrides,
  ChatOrderStateMutationResult,
  ChatReorderResult,
  FailedChatReorder,
  ProjectSettings,
  SettingsStoreContext,
} from './types.js';

const logger = createLogger('settings:chat-order');

const ORDER_LIST_KEYS = ['pinnedChatIds', 'normalChatIds', 'archivedChatIds'] as const;

type OrderListKey = typeof ORDER_LIST_KEYS[number];
type ChatOrderSnapshot = Record<OrderListKey, string[]>;

const ORDER_GROUP_KEYS: Record<PersistedChatOrderGroup, OrderListKey> = {
  pinned: 'pinnedChatIds',
  normal: 'normalChatIds',
  archived: 'archivedChatIds',
};

const ORDER_GROUP_BY_LIST_KEY: Record<OrderListKey, PersistedChatOrderGroup> = {
  pinnedChatIds: 'pinned',
  normalChatIds: 'normal',
  archivedChatIds: 'archived',
};

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

function sessionNotFound(error: string): FailedChatReorder {
  return {
    success: false,
    error,
    errorCode: 'SESSION_NOT_FOUND',
    status: 404,
  };
}

function orderStateResponse(
  chatId: string,
  orderGroup: PersistedChatOrderGroup,
  changed: boolean,
): SetChatOrderStateResponse {
  return {
    success: true,
    chatId,
    orderGroup,
    isPinned: orderGroup === 'pinned',
    isArchived: orderGroup === 'archived',
    changed,
  };
}

export class ChatOrderStore {
  #context: SettingsStoreContext;

  constructor(context: SettingsStoreContext) {
    this.#context = context;
  }

  async reconcileWithRegistry(registry: IChatRegistry): Promise<void> {
    return this.#context.mutate(async () => {
      const allChatIds = new Set(registry.listChatIds());
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
      await this.#context.saveAndEmitList(settings, pinnedChanged, 'chat-added', chatId);
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
      await this.#context.saveAndEmitList(s, true, 'pinned-toggled', chatId);
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
      await this.#context.saveAndEmitList(s, pinnedChanged, 'archive-toggled', chatId);
      return { isArchived: !isArchived };
    });
  }

  async setPinned(
    chatId: string,
    isPinned: boolean,
    isKnownChat: (chatId: string) => boolean,
  ): Promise<ChatOrderStateMutationResult> {
    return this.#context.mutate(async () => {
      if (!isKnownChat(chatId)) return sessionNotFound('Chat not found');
      const settings = this.#context.readSettings();
      const before = orderSnapshot(settings);
      const beforePinned = dedup(settings.pinnedChatIds || []);
      const currentGroup = resolveOrReconcileGroup(settings, chatId);
      let orderGroup = currentGroup;
      if (isPinned && currentGroup !== 'pinned') {
        removeFromEveryOrderGroup(settings, chatId);
        const position = settings.ui?.pinnedInsertPosition === 'bottom' ? 'bottom' : 'top';
        settings.pinnedChatIds = position === 'bottom'
          ? [...settings.pinnedChatIds, chatId]
          : [chatId, ...settings.pinnedChatIds];
        orderGroup = 'pinned';
      } else if (!isPinned && currentGroup === 'pinned') {
        removeFromEveryOrderGroup(settings, chatId);
        settings.normalChatIds = [chatId, ...settings.normalChatIds];
        orderGroup = 'normal';
      }
      const changed = !sameOrderSnapshot(before, orderSnapshot(settings));
      if (changed) {
        const pinnedChanged = bumpRemoteSettingsVersionForPinnedChange(settings, beforePinned);
        await this.#context.saveAndEmitList(
          settings,
          pinnedChanged,
          'pinned-toggled',
          chatId,
        );
      }
      return { success: true, response: orderStateResponse(chatId, orderGroup, changed) };
    });
  }

  async setArchived(
    chatId: string,
    isArchived: boolean,
    isKnownChat: (chatId: string) => boolean,
  ): Promise<ChatOrderStateMutationResult> {
    return this.#context.mutate(async () => {
      if (!isKnownChat(chatId)) return sessionNotFound('Chat not found');
      const settings = this.#context.readSettings();
      const before = orderSnapshot(settings);
      const beforePinned = dedup(settings.pinnedChatIds || []);
      const currentGroup = resolveOrReconcileGroup(settings, chatId);
      let orderGroup = currentGroup;
      if (isArchived && currentGroup !== 'archived') {
        removeFromEveryOrderGroup(settings, chatId);
        settings.archivedChatIds = [chatId, ...settings.archivedChatIds];
        orderGroup = 'archived';
      } else if (!isArchived && currentGroup === 'archived') {
        removeFromEveryOrderGroup(settings, chatId);
        settings.normalChatIds = [chatId, ...settings.normalChatIds];
        orderGroup = 'normal';
      }
      const changed = !sameOrderSnapshot(before, orderSnapshot(settings));
      if (changed) {
        const pinnedChanged = bumpRemoteSettingsVersionForPinnedChange(settings, beforePinned);
        await this.#context.saveAndEmitList(
          settings,
          pinnedChanged,
          'archive-toggled',
          chatId,
        );
      }
      return { success: true, response: orderStateResponse(chatId, orderGroup, changed) };
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
      await this.#context.saveAndEmitList(
        settings,
        remoteSettingsChanged,
        'chats-reordered',
        request.chatId,
      );
      return { success: true, response };
    });
  }

  async sortChatOrder(
    compareChatIds: ChatOrderIdComparator,
    comparatorOverrides: ChatOrderComparatorOverrides = {},
  ): Promise<{ changed: boolean }> {
    return this.#context.mutate(async () => {
      const settings = this.#context.readSettings();
      const before = orderSnapshot(settings);
      let anchorChatId: string | null = null;

      for (const key of ORDER_LIST_KEYS) {
        const compare = comparatorOverrides[ORDER_GROUP_BY_LIST_KEY[key]] ?? compareChatIds;
        const sorted = [...before[key]].sort(compare);
        settings[key] = sorted;
        if (!anchorChatId && !sameOrderedStringArray(before[key], sorted)) {
          anchorChatId = sorted[0] ?? null;
        }
      }

      if (!anchorChatId) return { changed: false };

      const remoteSettingsChanged = bumpRemoteSettingsVersionForPinnedChange(
        settings,
        dedup(before.pinnedChatIds),
      );
      await this.#context.saveAndEmitList(
        settings,
        remoteSettingsChanged,
        'chats-reordered',
        anchorChatId,
      );
      return { changed: true };
    });
  }
}
