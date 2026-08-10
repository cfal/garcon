import type { ChatMessage } from '../../common/chat-types.js';
import type { ChatViewMessage, ChatViewPage } from '../../common/chat-view.js';

export interface ChatHistoryPage {
  messages: ChatMessage[];
  total: number;
  hasMore: boolean;
  offset: number;
  limit: number;
  compositeRevision: string;
  carryOverRevision: string;
  agentOwnershipEpoch: string;
  archivedLogicalCount: number;
  nativePrefixDigest: string | null;
}

export interface ChatTranscriptSnapshot {
  readonly messages: ChatMessage[];
  readonly nativeMessages: ChatMessage[];
  readonly compositeRevision: string;
  readonly carryOverRevision: string;
  readonly agentOwnershipEpoch: string;
  readonly archivedLogicalCount: number;
  readonly nativePrefixDigest: string;
}

export interface ChatViewLoader {
  loadAll(): Promise<ChatTranscriptSnapshot>;
  loadPage?(limit: number, offset: number): Promise<ChatHistoryPage | null>;
}

export interface AppendedChatViewMessages {
  generationId: string;
  messages: ChatViewMessage[];
  lastSeq: number;
  skipped?: boolean;
}
