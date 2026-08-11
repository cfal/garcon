import type { ChatMessage } from '../../common/chat-types.js';
import type { ChatViewMessage, ChatViewPage } from '../../common/chat-view.js';
import type { AgentProjectionState } from '@garcon/server-agent-interface';

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
  projectionState: AgentProjectionState | null;
}

export interface ChatTranscriptSnapshot {
  readonly messages: ChatMessage[];
  readonly nativeMessages: ChatMessage[];
  readonly compositeRevision: string;
  readonly carryOverRevision: string;
  readonly agentOwnershipEpoch: string;
  readonly archivedLogicalCount: number;
  readonly nativePrefixDigest: string;
  readonly projectionState: AgentProjectionState | null;
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

export interface ProjectionCommitViewInput {
  readonly previousProjection: AgentProjectionState;
  readonly checkpointProjection: AgentProjectionState;
  readonly appendedMessages: readonly ChatMessage[];
  readonly carryOverMessageCount: number;
}

export type ProjectionCommitViewApplication =
  | {
      readonly kind: 'applied';
      readonly generationId: string;
      readonly messages: ChatViewMessage[];
      readonly lastSeq: number;
    }
  | {
      readonly kind: 'already-applied';
      readonly generationId: string;
      readonly lastSeq: number;
    }
  | {
      readonly kind: 'relisted';
      readonly previousGenerationId: string | null;
      readonly generationId: string;
      readonly lastSeq: number;
    };
