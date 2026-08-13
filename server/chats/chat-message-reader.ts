import type { ChatMessage } from '../../common/chat-types.js';
import type { TranscriptPage } from '../../common/chat-view.js';
import type { AgentProjectionState } from '@garcon/server-agent-interface';

interface NativeTranscriptWindowBase {
  readonly messages: readonly ChatMessage[];
  readonly totalNativeMessages: number;
  readonly offsetFromNewest: number;
  readonly nativeRevision: string;
  readonly projectionState: AgentProjectionState | null;
}

export type NativeTranscriptWindow =
  | (NativeTranscriptWindowBase & { readonly kind: 'page' })
  | (NativeTranscriptWindowBase & { readonly kind: 'snapshot' });

export interface TranscriptPageReader {
  page(chatId: string, limit: number, beforeOrdinal?: number): Promise<TranscriptPage>;
}

// Complete point-in-time capture of the durable composite ledger: immutable
// carryover plus the current segment's durable rows, excluding the active
// streaming suffix. Share and export artifacts record its identity so a
// published copy names exactly which transcript content produced it.
export interface CompositeDurableSnapshot {
  readonly messages: readonly ChatMessage[];
  readonly contentEpoch: string | null;
  readonly compositeRevision: string;
  readonly carryOverRevision: string;
  readonly agentOwnershipEpoch: string;
  readonly durableCount: number;
  readonly archivedLogicalCount: number;
}

export interface CompositeSnapshotPort {
  captureDurableSnapshot(chatId: string): Promise<CompositeDurableSnapshot>;
}
