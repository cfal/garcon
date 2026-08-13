import type { ChatMessage } from '../../common/chat-types.js';
import type { AgentProjectionState } from '@garcon/server-agent-interface';

export interface LegacyChatViewMessage {
  readonly seq: number;
  readonly message: ChatMessage;
}

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
  projectionState: AgentProjectionState | null;
}

export interface ChatTranscriptSnapshot {
  readonly messages: readonly ChatMessage[];
  readonly compositeRevision: string;
  readonly carryOverRevision: string;
  readonly agentOwnershipEpoch: string;
  readonly archivedLogicalCount: number;
  readonly projectionState: AgentProjectionState | null;
}

export interface ChatViewLoader {
  loadAll(): Promise<ChatTranscriptSnapshot>;
  loadPage?(limit: number, offset: number): Promise<ChatHistoryPage | null>;
}

// One browser generation of a chat view. Rows are exact ledger material at
// seq = carryover count + entry ordinal; there is no separate live overlay.
export interface MutableChatView {
  chatId: string;
  generationId: string;
  messages: LegacyChatViewMessage[];
  lastSeq: number;
  historyLastSeq: number;
  complete: boolean;
  loadedFromFullHistory: boolean;
  retainedStartSeq: number;
  compositeRevision?: string;
  carryOverRevision?: string;
  agentOwnershipEpoch?: string;
  archivedLogicalCount: number;
  projectionState: AgentProjectionState | null;
  streamFence: number;
  lastAccessAt: number;
  lastAccessOrder: number;
}

export type ChatViewGenerationReason =
  | 'projection-load'
  | 'projection-page'
  | 'projection-extended'
  | 'projection-replaced'
  | 'projection-reset'
  | 'projection-relist';

export interface ChatViewGenerationTransition {
  reason: ChatViewGenerationReason;
  previousGenerationId?: string;
  generationId?: string;
  persistence?: Pick<
    ChatTranscriptSnapshot,
    | 'agentOwnershipEpoch'
    | 'archivedLogicalCount'
    | 'carryOverRevision'
    | 'compositeRevision'
    | 'projectionState'
  >;
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
      readonly messages: LegacyChatViewMessage[];
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
