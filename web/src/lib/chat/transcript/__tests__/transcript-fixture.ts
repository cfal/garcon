import type { ActiveTranscriptState } from '../active-transcript-state.svelte.js';
import type { TranscriptWindowPage } from '../transcript-window-loader.js';

export function seedTranscript(
	transcript: ActiveTranscriptState,
	chatId: string,
	transcriptViewId: string,
	messages: TranscriptWindowPage['messages'],
	options: Omit<TranscriptWindowPage, 'transcriptViewId' | 'messages' | 'pageNewestOrdinal'> & { pageNewestOrdinal?: number },
): void {
	transcript.resetForNewChat();
	transcript.activeChatId = chatId;
	const result = transcript.setFromPage(chatId, {
		...options,
		transcriptViewId,
		messages,
		pageNewestOrdinal: options.pageNewestOrdinal ?? options.lastOrdinal,
		resendCandidates: options.resendCandidates ?? [],
	}, transcript.beginSnapshotLoad());
	if (result !== 'applied') throw new Error(`Cannot seed transcript: ${result}`);
}
