import type { ResendCandidate, TranscriptMessage } from '$shared/chat-view';
import type { ChatTranscriptApplyResult } from '$lib/chat/transcript/chat-transcript-cache.svelte.js';
import type { TranscriptReplayApplyResult } from '$lib/chat/transcript/transcript-reconnect-replay.js';
import type { ChatViewSurfaceId } from '$lib/workspace/surface-types.js';

export interface CommittedTranscriptBatch {
	readonly chatId: string;
	readonly transcriptViewId: string;
	readonly messages: TranscriptMessage[];
	readonly firstOrdinal: number;
	readonly lastOrdinal: number;
	readonly resendCandidates: ResendCandidate[];
	readonly noticeRevision: number;
}

export type ConversationPanelBatchApplyResult =
	| {
			readonly kind: 'applied';
			readonly localRecoverySurfaceIds: readonly ChatViewSurfaceId[];
	  }
	// The batch did not continue the cache, which keeps its contiguous prefix for a catch-up.
	| { readonly kind: 'prefix-retained' }
	| {
			readonly kind: 'chat-recovery-required';
			readonly outcome: Exclude<ChatTranscriptApplyResult, { status: 'applied' | 'gap-detected' }>;
	  };

// A retained prefix counts as applied: the panel registry already owns recovering its suffix.
export function committedBatchApplyStatus(
	result: ConversationPanelBatchApplyResult,
): TranscriptReplayApplyResult {
	if (result.kind === 'prefix-retained') return 'applied';
	if (result.kind === 'applied') {
		return result.localRecoverySurfaceIds.length === 0 ? 'applied' : 'gap-detected';
	}
	return result.outcome.status === 'view-changed' ? 'view-changed' : 'gap-detected';
}
