import type { ChatMessage } from '@garcon/common/chat-types';
import type {
  AgentChatReference,
  AgentNativeSessionRef,
  AgentTranscriptSourceLocation,
} from '@garcon/server-agent-interface';

// Provider-private native evidence contract. Native history bootstraps a
// segment's owned projection, anchors execution and fork continuity, and
// serves import/audit reads; it is never a public serving surface. The only
// public transcript contract is AgentTranscriptStream.
export interface AgentNativeEvidenceRequest {
  readonly chat: AgentChatReference;
  readonly signal: AbortSignal;
}

export interface AgentNativeEvidenceSnapshot {
  readonly messages: readonly ChatMessage[];
}

export interface AgentNativeEvidenceSource {
  // Returns a provider-validated reference that is at least as recoverable as
  // the current reference, or null when no safe update is available.
  resolveNativeSession(request: AgentNativeEvidenceRequest): Promise<AgentNativeSessionRef | null>;
  load(request: AgentNativeEvidenceRequest): Promise<AgentNativeEvidenceSnapshot>;
  describeSource(request: AgentNativeEvidenceRequest): Promise<AgentTranscriptSourceLocation | null>;
  release(request: AgentNativeEvidenceRequest & { readonly reason: 'deleted' | 'transferred' }): Promise<void>;
}
