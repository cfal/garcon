// Extracts API orchestration from Sidebar.svelte so the component
// remains a thin rendering shell. All server-side mutations and
// refresh coordination live here.

import {
	togglePinned,
	toggleArchive,
	reorderChatsQuick,
	getChatDetails,
	forkChat,
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

	async forkChat(sourceChatId: string): Promise<string> {
		const candidateId = `${Date.now()}`;
		const result = await forkChat({ sourceChatId, chatId: candidateId });
		await this.deps.onQuietRefresh();
		return result.chatId;
	}
}
