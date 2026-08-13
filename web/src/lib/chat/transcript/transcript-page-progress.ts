import {
	isContiguousChatViewWindow,
	isRequestedChatViewPage,
	type ChatViewMessage,
	type ChatViewPageRequest,
	type ChatViewWindow,
} from '$shared/chat-view';

export function validateRequestedTranscriptPage(
	request: ChatViewPageRequest,
	page: ChatViewWindow & { readonly limit: number },
): boolean {
	return isRequestedChatViewPage(request, page);
}

export function validateLatestTranscriptWindow(
	pageOldestSeq: number,
	lastSeq: number,
	hasMore: boolean,
	pageMessages: readonly ChatViewMessage[],
): boolean {
	if (!isContiguousChatViewWindow({ pageOldestSeq, lastSeq, hasMore, messages: pageMessages })) {
		return false;
	}
	if (pageMessages.length === 0) return lastSeq === 0;
	return pageMessages.at(-1)?.seq === lastSeq;
}
