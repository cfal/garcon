import type { AgentSettingsEnvelope } from '@garcon/common/agent-integration';
import type { ChatMessage } from '@garcon/common/chat-types';
import type { JsonObject } from '@garcon/common/json';

export interface AgentTranscript {
  resolveNativeSession(request: AgentTranscriptRequest): Promise<AgentNativeSessionRef | null>;
  load(request: AgentTranscriptRequest): Promise<AgentTranscriptSnapshot>;
  loadPage?(
    request: AgentTranscriptRequest & { readonly page: { readonly limit: number; readonly offset: number } },
  ): Promise<AgentTranscriptPage | null>;
  preview(request: AgentTranscriptRequest): Promise<AgentTranscriptPreview | null>;
  revision(request: AgentTranscriptRequest): Promise<string>;
  release(request: AgentTranscriptReleaseRequest): Promise<void>;
}

export interface AgentTranscriptSnapshot {
  readonly messages: readonly ChatMessage[];
  readonly revision: string;
}

export interface AgentTranscriptRequest {
  readonly chat: AgentChatReference;
  readonly signal: AbortSignal;
}

export interface AgentTranscriptPreview {
  readonly firstMessage: string;
  readonly lastMessage: string;
  readonly createdAt: string | null;
  readonly lastActivity: string | null;
}

export interface AgentTranscriptPage {
  readonly messages: readonly ChatMessage[];
  readonly total: number;
  readonly hasMore: boolean;
  readonly offset: number;
  readonly limit: number;
  readonly revision: string;
}

export interface AgentTranscriptReleaseRequest extends AgentTranscriptRequest {
  readonly reason: 'deleted' | 'transferred';
}

export interface AgentNativeSessionRef {
  readonly ownerId: string;
  readonly schemaVersion: number;
  readonly value: JsonObject;
}

export interface AgentChatReference {
  readonly chatId: string;
  readonly agentId: string;
  readonly agentSessionId: string | null;
  readonly projectPath: string;
  readonly model: string;
  readonly nativeSession: AgentNativeSessionRef | null;
  readonly carryOverRevision: string;
  readonly settings: AgentSettingsEnvelope;
}
