import type { ChatListEntry, ChatOrderGroup } from '../../common/chat-list.js';
import type { ChatSnapshotChat } from '../../common/chat-snapshot.js';
import type { ChatProcessingPhase } from '../../common/chat-types.js';
import {
  normalizePermissionMode,
  normalizeThinkingMode,
} from '../../common/chat-modes.js';
import { chatIdCreatedAt } from '../../common/chat-id.js';
import { normalizeTags } from '../../common/tags.js';
import type { ChatMetadata } from './metadata-store.js';
import type { ChatRegistryEntry, IChatRegistry } from './store.js';
import type { PathCache, ProjectPathStatus } from './path-cache.js';
import { extractFirstLine } from '../lib/text.js';

interface ChatListProjectorSettings {
  getPinnedChatIds(): string[];
  getNormalChatIds(): string[];
  getArchivedChatIds(): string[];
  getChatName(chatId: string): string | null;
}

interface ChatListProjectorMetadata {
  listAllChatMetadata(): Map<string, ChatMetadata>;
  getChatMetadata(chatId: string): ChatMetadata | null;
}

export interface ChatListMembershipSnapshot {
  pinned: ReadonlySet<string>;
  normal: ReadonlySet<string>;
  archived: ReadonlySet<string>;
}

export interface ChatListProjectorDeps {
  registry: Pick<IChatRegistry, 'getChat'>;
  settings: ChatListProjectorSettings;
  metadata: ChatListProjectorMetadata;
  processing: { phase(chatId: string): ChatProcessingPhase | null };
  pathCache: Pick<PathCache, 'resolveProjectPath'>;
}

export interface ChatSummaryProjection {
  chat: ChatSnapshotChat;
  processingPhase: ChatProcessingPhase | null;
}

export class ChatListProjector {
  constructor(private readonly deps: ChatListProjectorDeps) {}

  membershipSnapshot(): ChatListMembershipSnapshot {
    return {
      pinned: new Set(this.deps.settings.getPinnedChatIds()),
      normal: new Set(this.deps.settings.getNormalChatIds()),
      archived: new Set(this.deps.settings.getArchivedChatIds()),
    };
  }

  buildSummary(chatId: string): ChatSummaryProjection | null {
    const session = this.deps.registry.getChat(chatId);
    if (!session) return null;
    return this.#summary(
      chatId,
      session,
      this.deps.metadata.getChatMetadata(chatId),
    );
  }

  async buildMany(
    sessions: readonly (readonly [string, ChatRegistryEntry])[],
    statuses: ReadonlyMap<string, ProjectPathStatus>,
  ): Promise<Map<string, ChatListEntry>> {
    const metadata = this.deps.metadata.listAllChatMetadata();
    const membership = this.membershipSnapshot();
    const entries = new Map<string, ChatListEntry>();
    for (const [chatId, session] of sessions) {
      const status = statuses.get(session.projectPath);
      if (!status?.available || !status.effectiveProjectKey) continue;
      const chatMetadata = metadata.get(chatId) ?? null;
      const summary = this.#summary(chatId, session, chatMetadata);
      entries.set(
        chatId,
        this.#listEntry(
          summary,
          session,
          status.effectiveProjectKey,
          chatMetadata,
          membership,
        ),
      );
    }
    return entries;
  }

  async buildOne(chatId: string): Promise<ChatListEntry | null> {
    const session = this.deps.registry.getChat(chatId);
    if (!session) return null;
    const status = await this.deps.pathCache.resolveProjectPath(
      session.projectPath,
    );
    if (!status.available || !status.effectiveProjectKey) return null;
    const metadata = this.deps.metadata.getChatMetadata(chatId);
    const summary = this.#summary(chatId, session, metadata);
    return this.#listEntry(
      summary,
      session,
      status.effectiveProjectKey,
      metadata,
      this.membershipSnapshot(),
    );
  }

  #summary(
    chatId: string,
    session: ChatRegistryEntry,
    metadata: ChatMetadata | null,
  ): ChatSummaryProjection {
    const inferredCreatedAt = chatIdCreatedAt(chatId).toISOString();
    const overrideTitle = this.deps.settings.getChatName(chatId);
    const title = extractFirstLine(
      overrideTitle || metadata?.firstMessage || 'New Session',
    ) || 'New Session';
    return {
      chat: {
        id: chatId,
        agentId: session.agentId,
        model: session.model || null,
        apiProviderId: session.apiProviderId ?? null,
        modelEndpointId: session.modelEndpointId ?? null,
        modelProtocol: session.modelProtocol ?? null,
        permissionMode: normalizePermissionMode(session.permissionMode),
        thinkingMode: normalizeThinkingMode(session.thinkingMode),
        title,
        projectPath: session.projectPath,
        tags: normalizeTags(session.tags ?? []),
        activity: {
          createdAt: metadata?.createdAt || inferredCreatedAt,
          lastActivityAt: metadata?.lastActivity ?? null,
        },
      },
      processingPhase: this.deps.processing.phase(chatId),
    };
  }

  #listEntry(
    summary: ChatSummaryProjection,
    session: ChatRegistryEntry,
    effectiveProjectKey: string,
    metadata: ChatMetadata | null,
    membership: ChatListMembershipSnapshot,
  ): ChatListEntry {
    const { chat, processingPhase } = summary;
    const orderGroup = classifyOrderGroup(chat.id, membership);
    const title = chat.title;
    const firstPreview = extractFirstLine(metadata?.firstMessage || title);
    const lastPreview = extractFirstLine(
      metadata?.lastMessage || metadata?.firstMessage || title,
    );
    const lastReadAt = session.lastReadAt ?? null;
    const lastActivityAt = chat.activity.lastActivityAt;
    return {
      id: chat.id,
      agentId: chat.agentId,
      agentOwnershipEpoch: session.agentOwnershipEpoch,
      model: chat.model,
      apiProviderId: chat.apiProviderId,
      modelEndpointId: chat.modelEndpointId,
      modelProtocol: chat.modelProtocol,
      permissionMode: chat.permissionMode,
      thinkingMode: chat.thinkingMode,
      agentSettings: session.agentSettingsById[session.agentId] ?? {
        ownerId: session.agentId,
        schemaVersion: 1,
        values: {},
      },
      title,
      projectPath: chat.projectPath,
      effectiveProjectKey,
      orderGroup,
      tags: chat.tags,
      activity: {
        createdAt: chat.activity.createdAt,
        lastActivityAt,
        lastReadAt,
      },
      preview: {
        lastMessage: lastPreview,
        firstMessage: firstPreview,
      },
      isActive: processingPhase !== null,
      isProcessing: processingPhase !== null,
      processingPhase,
      isPinned: orderGroup === 'pinned',
      isArchived: orderGroup === 'archived',
      isUnread: Boolean(
        lastActivityAt && (!lastReadAt || lastActivityAt > lastReadAt),
      ),
    };
  }
}

export function classifyOrderGroup(
  chatId: string,
  membership: ChatListMembershipSnapshot,
): ChatOrderGroup {
  if (membership.pinned.has(chatId)) return 'pinned';
  if (membership.normal.has(chatId)) return 'normal';
  if (membership.archived.has(chatId)) return 'archived';
  return 'orphan';
}
