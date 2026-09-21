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

export interface AgentHistoryImportRequest {
  readonly chat: AgentChatReference;
  readonly signal: AbortSignal;
}

export interface AgentHistoryImport {
  load(
    request: AgentHistoryImportRequest,
  ): AsyncIterable<readonly AgentImportedTranscriptRow[]>;
}

export interface AgentNativeSessionAccess {
  resolveNativeSession(request: AgentHistoryImportRequest): Promise<AgentNativeSessionRef | null>;
  describeSource(request: AgentHistoryImportRequest): Promise<AgentTranscriptSourceLocation | null>;
  // Releases retained runtime resources for the captured chat/native session, even when idle.
  // Idempotent and scoped: never retires a replacement binding or a shared provider server.
  // Native-history removal remains provider policy; process termination is best-effort.
  release(
    request: AgentHistoryImportRequest & { readonly reason: 'deleted' | 'transferred' },
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
