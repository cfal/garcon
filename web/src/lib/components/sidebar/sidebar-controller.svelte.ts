// Extracts API orchestration from Sidebar.svelte so the component
// remains a thin rendering shell. All server-side mutations and
// refresh coordination live here.

import {
	togglePinned,
	toggleArchive,
	deleteChat,
	reorderChatsQuick,
	getChatDetails,
	forkChat,
	setChatTags,
} from '$lib/api/chats.js';

export interface SidebarControllerDeps {
	get onQuietRefresh(): () => Promise<void> | void;
}

export class SidebarController {
	private deps: SidebarControllerDeps;

	constructor(deps: SidebarControllerDeps) {
		this.deps = deps;
	}

	async togglePinned(chatId: string): Promise<void> {
		await togglePinned(chatId);
		await this.deps.onQuietRefresh();
	}

	async toggleArchive(chatId: string): Promise<void> {
		await toggleArchive(chatId);
		await this.deps.onQuietRefresh();
	}

	async quickMove(chatId: string, chatIdAbove?: string, chatIdBelow?: string): Promise<void> {
		await reorderChatsQuick({ chatId, chatIdAbove, chatIdBelow });
		await this.deps.onQuietRefresh();
	}

	async loadDetails(chatId: string) {
		return getChatDetails(chatId);
	}

	async updateTags(chatId: string, tags: string[]): Promise<void> {
		await setChatTags(chatId, tags);
		await this.deps.onQuietRefresh();
	}

	async forkChat(sourceChatId: string): Promise<string> {
		const candidateId = `${Date.now()}`;
		const result = await forkChat({ sourceChatId, chatId: candidateId });
		await this.deps.onQuietRefresh();
		return result.chatId;
	}

	// Bulk operations. Calls individual toggle APIs in parallel then
	// refreshes once. Callers must pre-filter to only include chats
	// that need toggling (e.g. only unpinned chats for a "pin" action).

	async bulkDelete(chatIds: string[]): Promise<void> {
		await Promise.all(chatIds.map((id) => deleteChat(id)));
		await this.deps.onQuietRefresh();
	}

	async bulkTogglePin(chatIds: string[]): Promise<void> {
		await Promise.all(chatIds.map((id) => togglePinned(id)));
		await this.deps.onQuietRefresh();
	}

	async bulkToggleArchive(chatIds: string[]): Promise<void> {
		await Promise.all(chatIds.map((id) => toggleArchive(id)));
		await this.deps.onQuietRefresh();
	}
}
