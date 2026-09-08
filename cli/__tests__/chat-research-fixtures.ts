import type { ChatListEntry, ChatListResponse } from '@garcon/common/chat-list';

export const CHAT_ID = '1785337200123456';
export const OTHER_CHAT_ID = '1785337200123457';
export const TS = '2026-09-07T00:00:00.000Z';

export function chat(overrides: Partial<ChatListEntry> = {}): ChatListEntry {
  const agentId = overrides.agentId ?? 'codex';
  return {
    id: CHAT_ID,
    parentChat: null,
    agentId,
    agentOwnershipEpoch: 'epoch-1',
    model: 'gpt-5.4',
    apiProviderId: null,
    modelEndpointId: null,
    modelProtocol: null,
    permissionMode: 'acceptEdits',
    thinkingMode: 'high',
    agentSettings: { ownerId: agentId, schemaVersion: 1, values: {} },
    title: 'Search work',
    projectPath: '/garcon',
    orderGroup: 'normal',
    tags: ['cli'],
    activity: { createdAt: TS, lastActivityAt: TS, lastReadAt: null },
    preview: { firstMessage: 'Find it', lastMessage: 'Done' },
    isPinned: false,
    isArchived: false,
    isActive: false,
    isProcessing: false,
    processingPhase: null,
    canReloadFromNativeHistory: true,
    isUnread: false,
    ...overrides,
  };
}

export function chatList(sessions: ChatListEntry[]): ChatListResponse {
  return { sessions, total: sessions.length, lastSelectedChatId: null };
}
