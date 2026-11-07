import {
	matchesChatFilter,
	parseChatSearch,
	type ChatFilterSpec,
} from '$shared/chat-filter-query';
import type { ChatSessionRecord } from '$lib/chat/sessions/chat-session-types';
import type { ChatSearchResult } from '$shared/chat-search';

export function matchesSidebarChatFilter(chat: ChatSessionRecord, spec: ChatFilterSpec): boolean {
	return matchesChatFilter(chat, { ...spec, collection: spec.collection ?? 'conversation' });
}

export function facetFilteredChats(
	spec: ChatFilterSpec,
	chats: readonly ChatSessionRecord[],
): ChatSessionRecord[] {
	const facetSpec: ChatFilterSpec = { ...spec, textTokens: [] };
	return chats.filter((chat) => matchesSidebarChatFilter(chat, facetSpec));
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
