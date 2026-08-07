import type { ChatMessage } from '../../common/chat-types.js';
import type { ChatViewPage } from '../../common/chat-view.js';
import type { NativeSnapshotReconciliation } from './chat-view-store.js';

interface NativeTranscriptWindowBase {
  readonly messages: readonly ChatMessage[];
  readonly totalNativeMessages: number;
  readonly offsetFromNewest: number;
  readonly nativeRevision: string;
}

export type NativeTranscriptWindow =
  | (NativeTranscriptWindowBase & { readonly kind: 'page' })
  | (NativeTranscriptWindowBase & { readonly kind: 'snapshot' });

export interface PendingInputHistoryReader {
  loadNativeMessages(chatId: string): Promise<ChatMessage[]>;
  loadNativeWindow?(input: {
    readonly chatId: string;
    readonly limit: number;
    readonly offsetFromNewest?: number;
    readonly signal: AbortSignal;
  }): Promise<NativeTranscriptWindow>;
  getRetainedHistoryMessages(chatId: string): ChatMessage[] | null;
  hasCompleteHistory?(chatId: string): boolean;
}

export interface ChatViewPageReader {
  getOrCreatePage(chatId: string, limit: number, beforeSeq?: number): Promise<ChatViewPage>;
  reconcileNativeSnapshot(chatId: string, input: NativeSnapshotReconciliation): Promise<void>;
}
