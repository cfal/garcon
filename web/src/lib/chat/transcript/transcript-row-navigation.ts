import { getChatMessages } from '$lib/api/chats.js';
import { ApiError } from '$lib/api/client.js';
import { isUnavailableChatHistoryResponse, type TranscriptPage } from '$shared/chat-view';

export interface TranscriptRowTarget {
	readonly chatId: string;
	readonly transcriptViewId: string;
	readonly ordinal: number;
}

export type TranscriptRowNavigationResult =
	'completed' | 'view-changed' | 'unavailable' | 'cancelled';
export type TranscriptRowWindowResult =
	'loaded' | Exclude<TranscriptRowNavigationResult, 'completed'>;

export async function loadTranscriptRowPage(
	target: TranscriptRowTarget,
	signal: AbortSignal,
): Promise<{ kind: 'loaded'; page: TranscriptPage } | { kind: 'view-changed' | 'unavailable' }> {
	if (
		!Number.isSafeInteger(target.ordinal) ||
		target.ordinal < 1 ||
		target.ordinal >= Number.MAX_SAFE_INTEGER
	) {
		return { kind: 'unavailable' };
	}
	try {
		const page = await getChatMessages(
			{
				chatId: target.chatId,
				transcriptViewId: target.transcriptViewId,
				beforeOrdinal: target.ordinal + 1,
				limit: 50,
			},
			{ signal },
		);
		if (isUnavailableChatHistoryResponse(page))
			throw new Error('Transcript history is unavailable');
		if (page.transcriptViewId !== target.transcriptViewId) return { kind: 'view-changed' };
		if (!page.messages.some((entry) => entry.ordinal === target.ordinal))
			return { kind: 'unavailable' };
		return { kind: 'loaded', page };
	} catch (error) {
		if (error instanceof ApiError && error.errorCode === 'STALE_TRANSCRIPT_VIEW')
			return { kind: 'view-changed' };
		throw error;
	}
}
