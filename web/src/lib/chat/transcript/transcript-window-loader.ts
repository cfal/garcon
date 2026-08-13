import {
	isDegradedChatHistoryResponse,
	type ChatHistoryResponse,
	type CompleteChatHistoryResponse,
	type ChatViewMessage,
	type ChatViewPageRequest,
} from '$shared/chat-view';
import { getChatMessages } from '$lib/api/chats.js';
import { validateRequestedTranscriptPage } from './transcript-page-progress.js';

const DEFAULT_PAGE_SIZE = 50;
export const MAX_LATEST_TRANSCRIPT_WINDOW = 200;

export type TranscriptWindowStageResult = ChatHistoryResponse;
type RetainableTranscriptPage = Pick<
	CompleteChatHistoryResponse,
	'generationId' | 'messages' | 'pageOldestSeq' | 'hasMore'
>;

export function retainLoadedTranscriptPrefix<TPage extends RetainableTranscriptPage>(
	currentGenerationId: string,
	currentMessages: ChatViewMessage[],
	page: TPage,
): TPage {
	if (page.generationId !== currentGenerationId || page.pageOldestSeq <= 1) return page;
	const prefixEnd = currentMessages.findIndex((entry) => entry.seq >= page.pageOldestSeq);
	if (prefixEnd <= 0) return page;
	const prefix = currentMessages.slice(0, prefixEnd);
	if (prefix.at(-1)?.seq !== page.pageOldestSeq - 1) return page;
	if (prefix.some((entry, index) => index > 0 && entry.seq !== prefix[index - 1]!.seq + 1)) {
		return page;
	}
	return {
		...page,
		messages: [...prefix, ...page.messages],
		pageOldestSeq: prefix[0]!.seq,
		hasMore: prefix[0]!.seq > 1,
	};
}

export async function stageLatestTranscriptWindow(
	chatId: string,
	minimumMessageCount: number,
): Promise<TranscriptWindowStageResult> {
	const targetCount = Math.min(
		MAX_LATEST_TRANSCRIPT_WINDOW,
		Math.max(DEFAULT_PAGE_SIZE, Math.floor(minimumMessageCount)),
	);
	const latestRequest = {
		chatId,
		limit: targetCount,
	};
	const latest = await getChatMessages(latestRequest);
	if (isDegradedChatHistoryResponse(latest)) return latest;
	assertPage(chatId, latestRequest, latest);
	return latest;
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
