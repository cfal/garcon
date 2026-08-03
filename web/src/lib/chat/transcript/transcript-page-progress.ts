import type { ChatViewMessage } from '$shared/chat-view';

export function collectEarlierTranscriptMessages(
	currentOldestSeq: number,
	pageMessages: readonly ChatViewMessage[],
): ChatViewMessage[] {
	const pageSeqs = new Set<number>();
	return pageMessages.filter((message) => {
		if (message.seq >= currentOldestSeq || pageSeqs.has(message.seq)) return false;
		pageSeqs.add(message.seq);
		return true;
	});
}
