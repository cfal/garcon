import type { AgentSettingsEnvelope } from '@garcon/common/agent-integration';
import type { JsonObject } from '@garcon/common/json';
import type { NativeSeedReceipt } from '@garcon/common/transcript-seed';

export type AgentTranscriptSourceLocation =
  | { readonly kind: 'filesystem-path'; readonly value: string }
  | { readonly kind: 'provider-reference'; readonly value: string };

export interface AgentTranscriptPreview {
  readonly firstMessage: string;
  readonly lastMessage: string;
  readonly createdAt: string | null;
  readonly lastActivity: string | null;
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
  readonly nativeSeedReceipt: NativeSeedReceipt | null;
  readonly settings: AgentSettingsEnvelope;
}
