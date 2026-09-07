import { chatActivityTimeMs, chatCreationTimeMs } from '$shared/chat-order-sort';
import type { ChatSearchSort } from '$shared/chat-search';
import type { ChatSessionRecord } from '$lib/types/chat-session';

export function sortChatSearchResults(
	chats: readonly ChatSessionRecord[],
	sort: ChatSearchSort,
): ChatSessionRecord[] {
	if (sort === 'relevance') return [...chats];
	const timeFor = sort === 'created' ? chatCreationTimeMs : chatActivityTimeMs;
	return chats
		.map((chat) => ({ chat, time: timeFor(chat) }))
		.sort((left, right) => right.time - left.time || left.chat.id.localeCompare(right.chat.id))
		.map(({ chat }) => chat);
}

export function captureChatSearchTimeOrder(
	chats: readonly ChatSessionRecord[],
	sort: ChatSearchSort,
): string[] | null {
	if (sort === 'relevance') return null;
	return sortChatSearchResults(chats, sort).map((chat) => chat.id);
}

export function sortChatSearchResultsByIdOrder(
	chats: readonly ChatSessionRecord[],
	orderedChatIds: readonly string[],
): ChatSessionRecord[] {
	const priorityByChatId = new Map(orderedChatIds.map((chatId, index) => [chatId, index]));
	return [...chats].sort((left, right) => {
		const leftPriority = priorityByChatId.get(left.id);
		const rightPriority = priorityByChatId.get(right.id);
		if (leftPriority === undefined) {
			return rightPriority === undefined ? left.id.localeCompare(right.id) : 1;
		}
		if (rightPriority === undefined) return -1;
		return leftPriority - rightPriority;
	});
}

export function sortChatSearchResultsWithCommittedTimeOrder(
	chats: readonly ChatSessionRecord[],
	sort: ChatSearchSort,
	committedTimeOrder: readonly string[] | null,
): ChatSessionRecord[] {
	if (sort === 'relevance' || committedTimeOrder === null) {
		return sortChatSearchResults(chats, sort);
	}
	return sortChatSearchResultsByIdOrder(chats, committedTimeOrder);
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
