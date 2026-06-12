import type { ApiProtocol } from './api-providers.js';
import type {
  AmpAgentMode,
  ClaudeThinkingMode,
  PermissionMode,
  ThinkingMode,
} from './chat-modes.js';

export interface ChatListEntry {
  id: string;
  agentId: string;
  model: string | null;
  apiProviderId?: string | null;
  modelEndpointId?: string | null;
  modelProtocol?: ApiProtocol | null;
  permissionMode: PermissionMode;
  thinkingMode: ThinkingMode;
  claudeThinkingMode: ClaudeThinkingMode;
  ampAgentMode: AmpAgentMode;
  title: string;
  projectPath: string;
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

export interface ChatListResponse {
  sessions: ChatListEntry[];
  total: number;
}
