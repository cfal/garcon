import type { ApiProtocol } from './api-providers.js';
import type { PermissionMode, ThinkingMode } from './chat-modes.js';
import type { AgentSettingsEnvelope } from './agent-integration.js';

export interface ChatListEntry {
  id: string;
  agentId: string;
  model: string | null;
  apiProviderId?: string | null;
  modelEndpointId?: string | null;
  modelProtocol?: ApiProtocol | null;
  permissionMode: PermissionMode;
  thinkingMode: ThinkingMode;
  agentSettings: AgentSettingsEnvelope;
  title: string;
  projectPath: string;
  effectiveProjectKey: string;
  orderGroup: ChatOrderGroup;
  tags: string[];
  activity: {
    createdAt: string | null;
    lastActivityAt: string | null;
    lastReadAt: string | null;
  };
  preview: {
    lastMessage: string;
    firstMessage?: string;
  };
  isPinned: boolean;
  isArchived: boolean;
  isActive: boolean;
  isUnread: boolean;
}

export type ChatOrderGroup = 'pinned' | 'orphan' | 'normal' | 'archived';

export interface ChatListResponse {
  sessions: ChatListEntry[];
  total: number;
  lastSelectedChatId: string | null;
}

export interface SetLastSelectedChatRequest {
  chatId: string | null;
}

export interface SetLastSelectedChatResponse {
  success: true;
  lastSelectedChatId: string | null;
}

export interface MarkChatsReadEntry {
  chatId: string;
  lastReadAt: string;
}

export interface MarkChatsReadRequest {
  entries: MarkChatsReadEntry[];
}

export interface MarkChatsReadResponse {
  success: true;
  results: MarkChatsReadEntry[];
}
