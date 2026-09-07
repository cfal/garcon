// Extracts API orchestration from Sidebar.svelte so the component
// remains a thin rendering shell. All server-side mutations and
// refresh coordination live here.

import {
	togglePinned,
	deleteChat,
	reorderChat,
	sortChatOrder,
	getChatDetails,
	forkChat,
	updateChatProjectPath,
} from '$lib/api/chats.js';
import { resolveArchiveReplacementChatId } from '$lib/chat/actions/archive-navigation';
import { createClientChatId } from '$shared/client-chat-id';
import type { ProjectPathPatchResponse } from '$shared/chat-command-contracts';
import type { ChatSessionRecord } from '$lib/types/chat-session';
import type { ChatListEntry } from '$shared/chat-list';
import type {
	RelativeChatOrderPlacement,
	SortChatOrderResponse,
} from '$shared/chat-order-contracts';
import type { ChatOrderSortKey } from '$shared/chat-order-sort';
import type { ChatArchiveMutation } from '$lib/chat/sessions/chat-sessions-contract';

export interface SidebarControllerDeps {
	get onQuietRefresh(): () => Promise<void> | void;
	get isArchiveMutationPending(): (chatId: string) => boolean;
	get startArchivingChats(): (chatIds: readonly string[]) => ChatArchiveMutation;
	get startUnarchivingChats(): (chatIds: readonly string[]) => ChatArchiveMutation;
}

export type SidebarBulkAction = 'pin' | 'unpin' | 'archive' | 'unarchive';

export interface SidebarBulkOperationInput {
	selectedChats: ChatSessionRecord[];
	allChats: ChatSessionRecord[];
	displayedChatIds: readonly string[];
	selectedChatId: string | null;
}

export interface SidebarBulkOperationPlan {
	affectedIds: string[];
	nextSelectedChatId: string | null;
	shouldCreateNewChat: boolean;
}

export interface SidebarBulkOperation extends SidebarBulkOperationPlan {
	completion: Promise<void>;
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

	async reorderChat(chatId: string, placement: RelativeChatOrderPlacement): Promise<void> {
		await reorderChat({ chatId, placement });
		await this.deps.onQuietRefresh();
	}

	async sortChatOrder(sortKey: ChatOrderSortKey): Promise<SortChatOrderResponse> {
		const response = await sortChatOrder({ sortKey });
		await this.deps.onQuietRefresh();
		return response;
	}

	async loadDetails(chatId: string) {
		return getChatDetails(chatId);
	}

	async updateProjectPath(chatId: string, projectPath: string): Promise<ProjectPathPatchResponse> {
		return updateChatProjectPath({ chatId, projectPath });
	}

	async forkChat(sourceChatId: string): Promise<ChatListEntry> {
		const candidateId = createClientChatId();
		const result = await forkChat({ sourceChatId, chatId: candidateId });
		return result.chat;
	}

	async bulkDelete(chatIds: string[]): Promise<void> {
		await Promise.all(chatIds.map((id) => deleteChat(id)));
		await this.deps.onQuietRefresh();
	}

	async bulkTogglePin(chatIds: string[]): Promise<void> {
		await Promise.all(chatIds.map((id) => togglePinned(id)));
		await this.deps.onQuietRefresh();
	}

	startBulkOperation(
		action: SidebarBulkAction,
		input: SidebarBulkOperationInput,
	): SidebarBulkOperation {
		const requestedIds = this.resolveBulkAffectedIds(action, input.selectedChats);
		let affectedIds = requestedIds;
		let completion: Promise<void>;

		switch (action) {
			case 'pin':
			case 'unpin':
				completion = affectedIds.length > 0 ? this.bulkTogglePin(affectedIds) : Promise.resolve();
				break;
			case 'archive': {
				const mutation = this.deps.startArchivingChats(requestedIds);
				affectedIds = mutation.chatIds;
				completion = mutation.completion;
				break;
			}
			case 'unarchive': {
				const mutation = this.deps.startUnarchivingChats(requestedIds);
				affectedIds = mutation.chatIds;
				completion = mutation.completion;
				break;
			}
		}

		return {
			...this.resolveArchiveSelection(action, affectedIds, input),
			completion,
		};
	}

	private resolveBulkAffectedIds(
		action: SidebarBulkAction,
		selectedChats: ChatSessionRecord[],
	): string[] {
		const availableChats = selectedChats.filter(
			(chat) => !this.deps.isArchiveMutationPending(chat.id),
		);
		switch (action) {
			case 'pin':
				return availableChats.filter((chat) => !chat.isPinned).map((chat) => chat.id);
			case 'unpin':
				return availableChats.filter((chat) => chat.isPinned).map((chat) => chat.id);
			case 'archive':
				return availableChats.filter((chat) => !chat.isArchived).map((chat) => chat.id);
			case 'unarchive':
				return availableChats.filter((chat) => chat.isArchived).map((chat) => chat.id);
		}
		return [];
	}

	private resolveArchiveSelection(
		action: SidebarBulkAction,
		affectedIds: string[],
		input: SidebarBulkOperationInput,
	): SidebarBulkOperationPlan {
		if (
			action !== 'archive' ||
			!input.selectedChatId ||
			!affectedIds.includes(input.selectedChatId)
		) {
			return { affectedIds, nextSelectedChatId: null, shouldCreateNewChat: false };
		}

		const affectedIdSet = new Set(affectedIds);
		const selectableChatIds = new Set(
			input.allChats
				.filter((chat) => !affectedIdSet.has(chat.id) && !chat.isArchived)
				.map((chat) => chat.id),
		);
		const nextSelectedChatId = resolveArchiveReplacementChatId({
			archivingChatId: input.selectedChatId,
			displayedChatIds: input.displayedChatIds,
			isSelectableChat: (chatId) => selectableChatIds.has(chatId),
		});
		return {
			affectedIds,
			nextSelectedChatId,
			shouldCreateNewChat: nextSelectedChatId === null,
		};
	}
}
