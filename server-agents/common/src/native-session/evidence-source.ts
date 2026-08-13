import type { ChatMessage } from '@garcon/common/chat-types';
import type {
  AgentChatReference,
  AgentNativeSessionRef,
  AgentNativeSessionAccess,
  AgentTranscriptSourceLocation,
} from '@garcon/server-agent-interface';

export interface AgentNativeEvidenceRequest {
  readonly chat: AgentChatReference;
  readonly signal: AbortSignal;
}

export interface AgentNativeEvidenceSnapshot {
  readonly messages: readonly ChatMessage[];
}

// Keeps provider-native reads behind the integration boundary. Core uses the
// ledger for serving and reaches native evidence only through explicit flows.
export interface AgentNativeEvidenceSource extends AgentNativeSessionAccess {
  resolveNativeSession(request: AgentNativeEvidenceRequest): Promise<AgentNativeSessionRef | null>;
  load(request: AgentNativeEvidenceRequest): Promise<AgentNativeEvidenceSnapshot>;
  describeSource(request: AgentNativeEvidenceRequest): Promise<AgentTranscriptSourceLocation | null>;
  release(request: AgentNativeEvidenceRequest & { readonly reason: 'deleted' | 'transferred' }): Promise<void>;
}
