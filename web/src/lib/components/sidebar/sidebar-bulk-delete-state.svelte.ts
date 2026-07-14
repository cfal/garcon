import type { ChatSessionRecord } from '$lib/types/chat-session';

export interface BulkDeleteConfirmation {
	chatIds: string[];
	chatTitles: string[];
}

export class SidebarBulkDeleteState {
	confirmation = $state<BulkDeleteConfirmation | null>(null);

	request(chats: ChatSessionRecord[], fallbackTitle: string): void {
		this.confirmation = {
			chatIds: chats.map((chat) => chat.id),
			chatTitles: chats.map((chat) => chat.title || fallbackTitle),
		};
	}

	clear(): void {
		this.confirmation = null;
	}
}
