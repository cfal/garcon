import { compareChatOrderNewestFirst } from '$shared/chat-order-sort';
import type { ChatSearchSort } from '$shared/chat-search';
import type { ChatSessionRecord } from '$lib/types/chat-session';

export function sortChatSearchResults(
	chats: readonly ChatSessionRecord[],
	sort: ChatSearchSort,
): ChatSessionRecord[] {
	if (sort === 'relevance') return [...chats];
	const compareTime = compareChatOrderNewestFirst(sort);
	return [...chats].sort((left, right) =>
		compareTime(left, right) || left.id.localeCompare(right.id),
	);
}

export function visibleChatSearchTimePrefix(
	sortedChats: readonly ChatSessionRecord[],
	loadedTranscriptChatIds: ReadonlySet<string>,
	pagingIncomplete: boolean,
): ChatSessionRecord[] {
	if (!pagingIncomplete) return [...sortedChats];
	let frontierIndex = -1;
	for (let index = 0; index < sortedChats.length; index += 1) {
		if (loadedTranscriptChatIds.has(sortedChats[index].id)) frontierIndex = index;
	}
	return frontierIndex < 0 ? [...sortedChats] : sortedChats.slice(0, frontierIndex + 1);
}
