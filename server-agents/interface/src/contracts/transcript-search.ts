import type { ChatSearchQueryV1, ChatSearchSnippet } from '@garcon/common/chat-search';
import type { AgentNativeSessionRef } from './transcript.js';

export interface AgentTranscriptSearch {
  reconcile(request: AgentSearchReconcileRequest): Promise<void>;
  search(request: AgentSearchRequest): Promise<AgentSearchResponse>;
  status(request: AgentSearchStatusRequest): Promise<AgentSearchStatus>;
  disableAndDelete(request: {
    readonly generation: AgentSearchGeneration;
    readonly signal: AbortSignal;
  }): Promise<void>;
}

export interface AgentSearchChat {
  readonly chatId: string;
  readonly projectPath: string;
  readonly model: string;
  readonly nativeSession: AgentNativeSessionRef | null;
  readonly updatedAt: string | null;
  readonly carryOverRevision: string;
  readonly transcriptRevision: string;
}

export interface AgentSearchReconcileRequest {
  readonly chats: readonly AgentSearchChat[];
  readonly generation: AgentSearchGeneration;
  readonly signal: AbortSignal;
}

export interface AgentSearchGeneration {
  readonly epoch: string;
  readonly sequence: number;
}

export interface AgentSearchRequest {
  readonly query: ChatSearchQueryV1;
  readonly chats: readonly AgentSearchChat[];
  readonly limit: number;
  readonly signal: AbortSignal;
}

export interface AgentSearchResponse {
  readonly hits: readonly AgentSearchHit[];
  readonly index: AgentSearchStatus;
}

export interface AgentSearchHit {
  readonly chatId: string;
  readonly matchedMessageCount: number;
  readonly snippets: readonly ChatSearchSnippet[];
}

export interface AgentSearchStatus {
  readonly indexedChatCount: number;
  readonly pendingChatCount: number;
  readonly failedChatCount: number;
  readonly unsupportedChatCount: number;
}

export interface AgentSearchStatusRequest {
  readonly chats: readonly AgentSearchChat[];
  readonly signal: AbortSignal;
}
