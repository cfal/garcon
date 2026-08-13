import {
	isDegradedChatHistoryResponse,
	type ChatHistoryResponse,
	type CompleteChatHistoryResponse,
	type ChatViewPageRequest,
} from '$shared/chat-view';
import { getChatMessages } from '$lib/api/chats.js';
import { validateRequestedTranscriptPage } from './transcript-page-progress.js';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

export type TranscriptWindowStageResult = ChatHistoryResponse | 'snapshot-changed';

export async function stageLatestTranscriptWindow(
	chatId: string,
	minimumMessageCount: number,
): Promise<TranscriptWindowStageResult> {
	const targetCount = Math.max(DEFAULT_PAGE_SIZE, Math.floor(minimumMessageCount));
	const latestRequest = {
		chatId,
		limit: Math.min(targetCount, MAX_PAGE_SIZE),
	};
	const latest = await getChatMessages(latestRequest);
	if (isDegradedChatHistoryResponse(latest)) return latest;
	assertPage(chatId, latestRequest, latest);

	let messages = latest.messages;
	let pageOldestSeq = latest.pageOldestSeq;
	let hasMore = latest.hasMore;
	while (messages.length < targetCount && hasMore) {
		const earlierRequest = {
			chatId,
			limit: Math.min(targetCount - messages.length, MAX_PAGE_SIZE),
			beforeSeq: pageOldestSeq,
		};
		const earlier = await getChatMessages(earlierRequest);
		if (isDegradedChatHistoryResponse(earlier)) return earlier;
		if (earlier.chatId !== chatId) throw new Error('Transcript page belongs to another chat');
		if (earlier.generationId !== latest.generationId) return 'snapshot-changed';
		// Same-generation tail growth stays outside fixed beforeSeq windows and replays from the buffer.
		if (!validateRequestedTranscriptPage(earlierRequest, earlier)) {
			throw new Error('Transcript page did not match its requested window');
		}
		if (earlier.messages.length === 0) {
			throw new Error('Transcript page did not extend the staged window');
		}
		messages = [...earlier.messages, ...messages];
		pageOldestSeq = earlier.pageOldestSeq;
		hasMore = earlier.hasMore;
	}

	return {
		...latest,
		messages,
		pageOldestSeq,
		hasMore,
	};
}

function assertPage(
	chatId: string,
	request: ChatViewPageRequest,
	page: CompleteChatHistoryResponse,
): void {
	if (page.chatId !== chatId) throw new Error('Transcript page belongs to another chat');
	if (!validateRequestedTranscriptPage(request, page)) {
		throw new Error('Transcript page did not match its requested window');
	}
}
