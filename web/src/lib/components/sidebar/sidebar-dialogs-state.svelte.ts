import type { SessionAgentId } from '$lib/types/app';
import type { ChatSessionRecord } from '$lib/types/chat-session';

export interface ChatDeleteConfirmation {
	chatId: string;
	chatTitle: string;
	agentId: SessionAgentId;
}

export interface BulkDeleteConfirmation {
	chatIds: string[];
	chatTitles: string[];
}

export interface ChatRenameConfirmation {
	chatId: string;
	currentName: string;
}

export interface ChatProjectPathDialog {
	chatId: string;
	chatTitle: string;
	currentProjectPath: string;
}

export interface ChatDetailsDialog {
	chatId: string;
	chatTitle: string;
	firstMessage: string | null;
	createdAt: string | null;
	lastActivityAt: string | null;
	agentSessionId: string | null;
	nativePath: string | null;
	isLoading: boolean;
	error: string | null;
}

export class SidebarDialogsState {
	bulkDeleteConfirmation = $state<BulkDeleteConfirmation | null>(null);
	chatDeleteConfirmation = $state<ChatDeleteConfirmation | null>(null);
	chatRenameConfirmation = $state<ChatRenameConfirmation | null>(null);
	chatProjectPathDialog = $state<ChatProjectPathDialog | null>(null);
	chatDetailsDialog = $state<ChatDetailsDialog | null>(null);
	tagDialog = $state<{ chatId: string; chatTitle: string; tags: string[] } | null>(null);
	shareChatDialog = $state<{ chatId: string; chatTitle: string } | null>(null);

	requestBulkDelete(chats: ChatSessionRecord[], fallbackTitle: string): void {
		this.bulkDeleteConfirmation = {
			chatIds: chats.map((chat) => chat.id),
			chatTitles: chats.map((chat) => chat.title || fallbackTitle),
		};
	}

	clearBulkDelete(): void {
		this.bulkDeleteConfirmation = null;
	}

	showDeleteConfirmation(chatId: string, chatTitle: string, agentId: SessionAgentId): void {
		this.chatDeleteConfirmation = { chatId, chatTitle, agentId };
	}

	clearDeleteConfirmation(): void {
		this.chatDeleteConfirmation = null;
	}

	startRename(chatId: string, currentName: string): void {
		this.chatRenameConfirmation = { chatId, currentName };
	}

	clearRename(): void {
		this.chatRenameConfirmation = null;
	}

	showProjectPathDialog(chatId: string, chatTitle: string, currentProjectPath: string): void {
		this.chatProjectPathDialog = { chatId, chatTitle, currentProjectPath };
	}

	closeProjectPathDialog(): void {
		this.chatProjectPathDialog = null;
	}

	showDetails(chatId: string, chatTitle: string): void {
		this.chatDetailsDialog = {
			chatId,
			chatTitle,
			firstMessage: null,
			createdAt: null,
			lastActivityAt: null,
			agentSessionId: null,
			nativePath: null,
			isLoading: true,
			error: null,
		};
	}

	completeDetails(
		chatId: string,
		details: {
			firstMessage: string | null;
			createdAt: string | null;
			lastActivityAt: string | null;
			agentSessionId: string | null;
			nativePath: string | null;
		},
	): void {
		if (!this.chatDetailsDialog || this.chatDetailsDialog.chatId !== chatId) return;
		this.chatDetailsDialog = {
			...this.chatDetailsDialog,
			...details,
			isLoading: false,
			error: null,
		};
	}

	failDetails(chatId: string, error: string): void {
		if (!this.chatDetailsDialog || this.chatDetailsDialog.chatId !== chatId) return;
		this.chatDetailsDialog = {
			...this.chatDetailsDialog,
			isLoading: false,
			error,
		};
	}

	closeDetails(): void {
		this.chatDetailsDialog = null;
	}

	showTagDialog(chatId: string, chatTitle: string, tags: string[]): void {
		this.tagDialog = { chatId, chatTitle, tags };
	}

	closeTagDialog(): void {
		this.tagDialog = null;
	}

	showShareDialog(chatId: string, chatTitle: string): void {
		this.shareChatDialog = { chatId, chatTitle };
	}

	closeShareDialog(): void {
		this.shareChatDialog = null;
	}
}
