import type { ChatSessionRecord } from '$lib/chat/sessions/chat-session-types';

export class ReactiveChatList {
	#chats = $state<ChatSessionRecord[]>([]);

	constructor(chats: ChatSessionRecord[]) {
		this.#chats = chats;
	}

	get chats(): ChatSessionRecord[] {
		return this.#chats;
	}

	replace(index: number, chat: ChatSessionRecord): void {
		this.#chats[index] = chat;
	}
}
