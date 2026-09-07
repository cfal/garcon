import {
	isEmptyFilter,
	matchesChatFilter,
	parseChatSearch,
	type ChatFilterSpec,
} from '$lib/sidebar/search/sidebar-search.js';
import type { ChatSessionRecord } from '$lib/types/chat-session';
import type { ChatSearchResult } from '$shared/chat-search';

export function facetFilteredChats(
	spec: ChatFilterSpec,
	chats: ChatSessionRecord[],
): ChatSessionRecord[] {
	const facetSpec: ChatFilterSpec = { ...spec, textTokens: [] };
	if (isEmptyFilter(facetSpec)) return chats;
	return chats.filter((chat) => matchesChatFilter(chat, facetSpec));
}

// Appends transcript-only matches after metadata matches for the same query.
export function mergeTranscriptMatches(
	query: string,
	metadataMatches: ChatSessionRecord[],
	chats: ChatSessionRecord[],
	transcriptMatches: { query: string; results: ChatSearchResult[] },
): ChatSessionRecord[] {
	if (transcriptMatches.query !== query || transcriptMatches.results.length === 0) {
		return metadataMatches;
	}
	const chatsById = new Map(chats.map((chat) => [chat.id, chat]));
	const candidateIds = new Set(
		facetFilteredChats(parseChatSearch(query), chats).map((chat) => chat.id),
	);
	const seen = new Set(metadataMatches.map((chat) => chat.id));
	const transcriptOnly = transcriptMatches.results
		.map((result) => chatsById.get(result.chatId))
		.filter((chat): chat is ChatSessionRecord => {
			if (!chat) return false;
			return candidateIds.has(chat.id) && !seen.has(chat.id);
		});
	return [...metadataMatches, ...transcriptOnly];
}
