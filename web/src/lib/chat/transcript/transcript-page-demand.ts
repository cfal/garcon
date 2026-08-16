import {
	CHAT_MESSAGES_MAX_LIMIT,
	isRelationallyValidBoundedTranscriptPage,
	isUnavailableChatHistoryResponse,
	type ChatHistoryResponse,
	type CompleteChatHistoryResponse,
	type TranscriptMessage,
	type TranscriptPage,
	type UnavailableChatHistoryResponse,
} from '$shared/chat-view';
import {
	getChatMessages,
	type ChatMessagesRequest,
} from '$lib/api/chats.js';
import { ApiError } from '$lib/api/client.js';

type CompletePage = CompleteChatHistoryResponse;

interface TranscriptPageDemandBase {
	chatId: string;
	visibleLimit: number;
	loadPage?: (request: ChatMessagesRequest) => Promise<ChatHistoryResponse>;
	isCurrent?: () => boolean;
	onPageValidated?: (request: ChatMessagesRequest, page: CompletePage) => void;
}

export type TranscriptPageDemandOptions = TranscriptPageDemandBase & (
	| {
			direction: 'backward';
			beforeOrdinal?: number;
			transcriptViewId?: string;
		}
	| {
			direction: 'later';
			afterOrdinal: number;
			throughOrdinal: number;
			transcriptViewId: string;
		}
);

export interface CompleteTranscriptPageDemand {
	kind: 'complete';
	pages: CompletePage[];
	messages: TranscriptMessage[];
	lastOrdinal: number;
}

export type TranscriptPageDemandResult =
	| CompleteTranscriptPageDemand
	| { kind: 'unavailable'; response: UnavailableChatHistoryResponse }
	| { kind: 'view-changed' }
	| { kind: 'invalidated' };

export async function loadTranscriptPageDemand(
	options: TranscriptPageDemandOptions,
): Promise<TranscriptPageDemandResult> {
	if (
		!Number.isSafeInteger(options.visibleLimit)
		|| options.visibleLimit <= 0
		|| options.visibleLimit > CHAT_MESSAGES_MAX_LIMIT
	) {
		throw new TypeError('Transcript visible limit is invalid');
	}

	const loadPage = options.loadPage ?? getChatMessages;
	let expectedTranscriptViewId = options.transcriptViewId ?? null;
	let remainingVisible = options.visibleLimit;
	let beforeOrdinal = options.direction === 'backward' ? options.beforeOrdinal : undefined;
	let loadedThroughOrdinal = options.direction === 'later' ? options.afterOrdinal : 0;
	const pages: CompletePage[] = [];
	let messages: TranscriptMessage[] = [];
	let lastOrdinal = 0;

	while (remainingVisible > 0) {
		const request = pageRequest(
			options,
			expectedTranscriptViewId,
			remainingVisible,
			beforeOrdinal,
			loadedThroughOrdinal,
		);
		if (request === null) break;

		let response: ChatHistoryResponse;
		try {
			response = await loadPage(request);
		} catch (error) {
			if (error instanceof ApiError && error.errorCode === 'STALE_TRANSCRIPT_VIEW') {
				return { kind: 'view-changed' };
			}
			throw error;
		}
		if (options.isCurrent && !options.isCurrent()) return { kind: 'invalidated' };
		if (isUnavailableChatHistoryResponse(response)) {
			return { kind: 'unavailable', response };
		}
		if (
			expectedTranscriptViewId !== null
			&& response.transcriptViewId !== expectedTranscriptViewId
		) {
			return { kind: 'view-changed' };
		}
		expectedTranscriptViewId = response.transcriptViewId;
		validateDemandPage(response, request);

		if (options.direction === 'later') {
			if (
				response.pageNewestOrdinal <= loadedThroughOrdinal
				|| response.messages.some((entry) => entry.ordinal <= loadedThroughOrdinal)
			) {
				throw new Error('Later transcript page did not advance the loaded window');
			}
			messages = [...messages, ...response.messages];
			loadedThroughOrdinal = response.pageNewestOrdinal;
		} else {
			messages = [...response.messages, ...messages];
			beforeOrdinal = response.nextBeforeOrdinal ?? undefined;
		}

		pages.push(response);
		lastOrdinal = Math.max(lastOrdinal, response.lastOrdinal);
		remainingVisible -= response.messages.length;
		options.onPageValidated?.(request, response);

		if (options.direction === 'later') {
			if (loadedThroughOrdinal >= options.throughOrdinal) break;
		} else if (response.nextBeforeOrdinal === null) {
			break;
		}
	}

	return { kind: 'complete', pages, messages, lastOrdinal };
}

export function collapseBackwardTranscriptDemand(
	demand: CompleteTranscriptPageDemand,
): TranscriptPage & { resendCandidates: CompletePage['resendCandidates'] } {
	const newestPage = demand.pages[0];
	const oldestPage = demand.pages.at(-1);
	if (!newestPage || !oldestPage) {
		throw new Error('Transcript demand completed without a page');
	}
	return {
		transcriptViewId: newestPage.transcriptViewId,
		messages: demand.messages,
		lastOrdinal: demand.lastOrdinal,
		pageOldestOrdinal: demand.messages[0]?.ordinal ?? 0,
		pageNewestOrdinal: newestPage.pageNewestOrdinal,
		nextBeforeOrdinal: oldestPage.nextBeforeOrdinal,
		hasMore: oldestPage.nextBeforeOrdinal !== null,
		resendCandidates: newestPage.resendCandidates,
	};
}

function pageRequest(
	options: TranscriptPageDemandOptions,
	transcriptViewId: string | null,
	remainingVisible: number,
	beforeOrdinal: number | undefined,
	loadedThroughOrdinal: number,
): ChatMessagesRequest | null {
	if (options.direction === 'later') {
		const remainingRaw = options.throughOrdinal - loadedThroughOrdinal;
		if (remainingRaw <= 0) return null;
		const limit = Math.min(remainingVisible, remainingRaw);
		return {
			chatId: options.chatId,
			limit,
			beforeOrdinal: loadedThroughOrdinal + limit + 1,
			transcriptViewId: options.transcriptViewId,
		};
	}

	if (beforeOrdinal !== undefined) {
		if (!transcriptViewId) throw new Error('Earlier transcript demand has no view');
		return {
			chatId: options.chatId,
			limit: remainingVisible,
			beforeOrdinal,
			transcriptViewId,
		};
	}
	return transcriptViewId
		? { chatId: options.chatId, limit: remainingVisible, transcriptViewId }
		: { chatId: options.chatId, limit: remainingVisible };
}

function validateDemandPage(page: CompletePage, request: ChatMessagesRequest): void {
	const requestLimit = request.limit ?? 50;
	const effectiveLimit = Math.min(requestLimit, CHAT_MESSAGES_MAX_LIMIT);
	const effectiveBefore = Math.min(
		request.beforeOrdinal ?? page.lastOrdinal + 1,
		page.lastOrdinal + 1,
	);
	if (
		page.chatId !== request.chatId
		|| page.limit !== effectiveLimit
		|| page.messages.length > effectiveLimit
		|| page.pageNewestOrdinal !== effectiveBefore - 1
		|| !isRelationallyValidBoundedTranscriptPage(page, effectiveLimit)
	) {
		throw new Error('Transcript page did not make valid bounded progress');
	}
}
