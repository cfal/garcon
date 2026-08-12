import type { ChatMessage } from '@garcon/common/chat-types';
import type { JsonObject } from '@garcon/common/json';
import type { AgentChatReference, AgentNativeSessionRef } from './transcript.js';

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

export type AgentNativeActivityResult =
  | { readonly kind: 'ready'; readonly value: { readonly lastEntryAt: string | null } }
  | { readonly kind: 'unavailable' };

export interface AgentNativeActivityProbe {
  lastActivity(
    ref: AgentNativeSessionRef,
    signal: AbortSignal,
  ): Promise<AgentNativeActivityResult>;
}
