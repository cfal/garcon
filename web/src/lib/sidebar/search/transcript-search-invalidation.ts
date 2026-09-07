import {
	isEmptyFilter,
	matchesChatFilter,
	parseChatSearch,
} from '$lib/sidebar/search/sidebar-search.js';
import { captureChatSearchTimeOrder } from '$lib/sidebar/search/search-result-order.js';
import type { ChatSessionRecord } from '$lib/types/chat-session';
import type { ChatSearchSort } from '$shared/chat-search';

export interface TranscriptSearchInvalidationProjection {
	readonly hasTranscriptTerms: boolean;
	readonly candidateSignature: string;
	readonly contentSignature: string;
	readonly timeOrderSignature: string;
}

export const EMPTY_TRANSCRIPT_SEARCH_INVALIDATION: TranscriptSearchInvalidationProjection = {
	hasTranscriptTerms: false,
	candidateSignature: '',
	contentSignature: '',
	timeOrderSignature: '',
};

export function transcriptSearchInvalidationProjection(
	chats: readonly ChatSessionRecord[],
	query: string,
	sort: ChatSearchSort,
): TranscriptSearchInvalidationProjection {
	const spec = parseChatSearch(query);
	if (spec.textTokens.length === 0) return EMPTY_TRANSCRIPT_SEARCH_INVALIDATION;
	const facetSpec = { ...spec, textTokens: [] };
	const candidates = isEmptyFilter(facetSpec)
		? [...chats]
		: chats.filter((chat) => matchesChatFilter(chat, facetSpec));
	const lexical = [...candidates].sort((left, right) => left.id.localeCompare(right.id));
	const timeOrder = captureChatSearchTimeOrder(candidates, sort);
	return {
		hasTranscriptTerms: true,
		candidateSignature: JSON.stringify(lexical.map((chat) => chat.id)),
		contentSignature: JSON.stringify(lexical.map((chat) => [chat.id, chat.lastActivityAt])),
		timeOrderSignature: timeOrder === null ? '' : JSON.stringify(timeOrder),
	};
}
