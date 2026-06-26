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
		updateChatProjectPath,
		type ReorderQuickTarget,
	} from '$lib/api/chats.js';
import type { ProjectPathPatchResponse } from '$shared/chat-command-contracts';
import type { ChatSessionRecord } from '$lib/types/chat-session';

export interface SidebarControllerDeps {
	get onQuietRefresh(): () => Promise<void> | void;
}

export type SidebarBulkAction = 'pin' | 'unpin' | 'archive' | 'unarchive';

export interface SidebarBulkOperationInput {
	selectedChats: ChatSessionRecord[];
	allChats: ChatSessionRecord[];
	selectedChatId: string | null;
}

export interface SidebarBulkOperationResult {
	affectedIds: string[];
	nextSelectedChatId: string | null;
	shouldCreateNewChat: boolean;
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

	async quickMove(chatId: string, target: ReorderQuickTarget): Promise<void> {
		await reorderChatsQuick({ chatId, ...target });
		await this.deps.onQuietRefresh();
	}

	async loadDetails(chatId: string) {
		return getChatDetails(chatId);
	}

	async updateTags(chatId: string, tags: string[]): Promise<void> {
		await setChatTags(chatId, tags);
		await this.deps.onQuietRefresh();
	}

	async updateProjectPath(chatId: string, projectPath: string): Promise<ProjectPathPatchResponse> {
		const result = await updateChatProjectPath({ chatId, projectPath });
		await this.deps.onQuietRefresh();
		return result;
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

	async runBulkOperation(
		action: SidebarBulkAction,
		input: SidebarBulkOperationInput,
	): Promise<SidebarBulkOperationResult> {
		const affectedIds = this.resolveBulkAffectedIds(action, input.selectedChats);
		const archiveSelection = this.resolveArchiveSelection(action, affectedIds, input);
		if (affectedIds.length === 0) return archiveSelection;

		if (action === 'pin' || action === 'unpin') {
			await this.bulkTogglePin(affectedIds);
		} else {
			await this.bulkToggleArchive(affectedIds);
		}

		return archiveSelection;
	}

	private resolveBulkAffectedIds(
		action: SidebarBulkAction,
		selectedChats: ChatSessionRecord[],
	): string[] {
		switch (action) {
			case 'pin':
				return selectedChats.filter((chat) => !chat.isPinned).map((chat) => chat.id);
			case 'unpin':
				return selectedChats.filter((chat) => chat.isPinned).map((chat) => chat.id);
			case 'archive':
				return selectedChats.filter((chat) => !chat.isArchived).map((chat) => chat.id);
			case 'unarchive':
				return selectedChats.filter((chat) => chat.isArchived).map((chat) => chat.id);
		}
		return [];
	}

	private resolveArchiveSelection(
		action: SidebarBulkAction,
		affectedIds: string[],
		input: SidebarBulkOperationInput,
	): SidebarBulkOperationResult {
		if (
			action !== 'archive' ||
			!input.selectedChatId ||
			!affectedIds.includes(input.selectedChatId)
		) {
			return { affectedIds, nextSelectedChatId: null, shouldCreateNewChat: false };
		}

		const remaining = input.allChats.find(
			(chat) => !affectedIds.includes(chat.id) && !chat.isArchived,
		);
		return {
			affectedIds,
			nextSelectedChatId: remaining?.id ?? null,
			shouldCreateNewChat: !remaining,
		};
	}
}
