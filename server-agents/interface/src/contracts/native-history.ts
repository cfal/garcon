import type { ChatMessage } from '@garcon/common/chat-types';
import type { JsonObject } from '@garcon/common/json';
import type {
  AgentChatReference,
  AgentNativeSessionRef,
  AgentTranscriptSourceLocation,
} from './transcript.js';

export interface AgentImportedTranscriptRow {
  readonly message: ChatMessage;
  readonly providerMeta?: JsonObject;
}

export interface AgentNativeHistoryImportRequest {
  readonly chat: AgentChatReference;
  readonly signal: AbortSignal;
}

export interface AgentNativeHistoryImport {
  load(
    request: AgentNativeHistoryImportRequest,
  ): AsyncIterable<readonly AgentImportedTranscriptRow[]>;
}

export interface AgentNativeSessionAccess {
  resolveNativeSession(request: AgentNativeHistoryImportRequest): Promise<AgentNativeSessionRef | null>;
  describeSource(request: AgentNativeHistoryImportRequest): Promise<AgentTranscriptSourceLocation | null>;
  release(
    request: AgentNativeHistoryImportRequest & { readonly reason: 'deleted' | 'transferred' },
  ): Promise<void>;
}

export type AgentNativeActivityResult =
  | { readonly kind: 'ready'; readonly value: { readonly lastEntryAt: string | null } }
  | { readonly kind: 'unavailable' };

export interface AgentNativeActivityProbe {
  lastActivity(
    ref: AgentNativeSessionRef,
    signal: AbortSignal,
  ): Promise<AgentNativeActivityResult>;
}
