import type { ChatListEntry, ChatOrderGroup } from '../../common/chat-list.js';
import {
  normalizePermissionMode,
  normalizeThinkingMode,
} from '../../common/chat-modes.js';
import { chatIdCreatedAt } from '../../common/chat-id.js';
import type { AgentRegistryServiceContract } from '../agents/registry.js';
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
  agents: Pick<AgentRegistryServiceContract, 'isAgentSessionRunning'>;
  pathCache: Pick<PathCache, 'resolveProjectPath'>;
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
      entries.set(
        chatId,
        this.#project(
          chatId,
          session,
          status.effectiveProjectKey,
          metadata.get(chatId) ?? null,
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
    return this.#project(
      chatId,
      session,
      status.effectiveProjectKey,
      this.deps.metadata.getChatMetadata(chatId),
      this.membershipSnapshot(),
    );
  }

  #project(
    chatId: string,
    session: ChatRegistryEntry,
    effectiveProjectKey: string,
    metadata: ChatMetadata | null,
    membership: ChatListMembershipSnapshot,
  ): ChatListEntry {
    const orderGroup = classifyOrderGroup(chatId, membership);
    const inferredCreatedAt = chatIdCreatedAt(chatId).toISOString();
    const overrideTitle = this.deps.settings.getChatName(chatId);
    const title = extractFirstLine(
      overrideTitle || metadata?.firstMessage || 'New Session',
    );
    const firstPreview = extractFirstLine(metadata?.firstMessage || title);
    const lastPreview = extractFirstLine(
      metadata?.lastMessage || metadata?.firstMessage || title,
    );
    const lastReadAt = session.lastReadAt ?? null;
    const lastActivityAt = metadata?.lastActivity ?? null;
    return {
      id: chatId,
      agentId: session.agentId,
      model: session.model || null,
      apiProviderId: session.apiProviderId ?? null,
      modelEndpointId: session.modelEndpointId ?? null,
      modelProtocol: session.modelProtocol ?? null,
      permissionMode: normalizePermissionMode(session.permissionMode),
      thinkingMode: normalizeThinkingMode(session.thinkingMode),
      agentSettings: session.agentSettingsById[session.agentId] ?? {
        ownerId: session.agentId,
        schemaVersion: 1,
        values: {},
      },
      title,
      projectPath: session.projectPath,
      effectiveProjectKey,
      orderGroup,
      tags: session.tags || [],
      activity: {
        createdAt: metadata?.createdAt || inferredCreatedAt,
        lastActivityAt,
        lastReadAt,
      },
      preview: {
        lastMessage: lastPreview,
        firstMessage: firstPreview,
      },
      isActive: this.deps.agents.isAgentSessionRunning(
        session.agentId,
        session.agentSessionId,
      ),
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
