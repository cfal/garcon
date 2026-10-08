import type { ChatSessionRecord } from './chat-session-types.js';

const VISITED_CHAT_LIMIT = 30;

export class RecentChatHistoryState {
	#visitedIds = $state.raw<readonly string[]>([]);

	visit(chatId: string): void {
		this.#visitedIds = [chatId, ...this.#visitedIds.filter((id) => id !== chatId)].slice(
			0,
			VISITED_CHAT_LIMIT,
		);
	}

	remove(chatId: string): void {
		this.#visitedIds = this.#visitedIds.filter((id) => id !== chatId);
	}

	prune(records: Readonly<Record<string, ChatSessionRecord>>): void {
		this.#visitedIds = this.#visitedIds.filter((id) => Boolean(records[id]));
	}

	rankChats(chats: readonly ChatSessionRecord[]): readonly ChatSessionRecord[] {
		const visits = new Map(this.#visitedIds.map((id, index) => [id, index]));
		return chats
			.filter((chat) => !chat.isArchived)
			.sort((a, b) => {
				const visitOrder =
					(visits.get(a.id) ?? VISITED_CHAT_LIMIT) - (visits.get(b.id) ?? VISITED_CHAT_LIMIT);
				return (
					visitOrder ||
					(b.lastActivityAt ?? b.createdAt ?? '').localeCompare(
						a.lastActivityAt ?? a.createdAt ?? '',
					)
				);
			});
	}
}
