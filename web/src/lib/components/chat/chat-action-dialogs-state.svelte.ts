import type { SessionAgentId } from '$lib/types/app';
import type { ChatSessionRecord } from '$lib/types/chat-session';

export interface ChatDeleteConfirmation {
	chatId: string;
	chatTitle: string;
	agentId: SessionAgentId;
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

export class ChatActionDialogsState {
	chatDeleteConfirmation = $state<ChatDeleteConfirmation | null>(null);
	chatRenameConfirmation = $state<ChatRenameConfirmation | null>(null);
	chatProjectPathDialog = $state<ChatProjectPathDialog | null>(null);
	chatDetailsDialog = $state<ChatDetailsDialog | null>(null);
	tagDialog = $state<{ chatId: string; chatTitle: string; tags: string[] } | null>(null);
	shareChatDialog = $state<{ chatId: string; chatTitle: string } | null>(null);

	requestDelete(chat: ChatSessionRecord, fallbackTitle: string): void {
		this.chatDeleteConfirmation = {
			chatId: chat.id,
			chatTitle: chat.title || fallbackTitle,
			agentId: chat.agentId,
		};
	}

	showDeleteConfirmation(chatId: string, chatTitle: string, agentId: SessionAgentId): void {
		this.chatDeleteConfirmation = { chatId, chatTitle, agentId };
	}

	clearDeleteConfirmation(): void {
		this.chatDeleteConfirmation = null;
	}

	requestRename(chat: ChatSessionRecord, fallbackTitle: string): void {
		this.chatRenameConfirmation = {
			chatId: chat.id,
			currentName: chat.title || fallbackTitle,
		};
	}

	startRename(chatId: string, currentName: string): void {
		this.chatRenameConfirmation = { chatId, currentName };
	}

	clearRename(): void {
		this.chatRenameConfirmation = null;
	}

	requestProjectPath(chat: ChatSessionRecord, fallbackTitle: string): void {
		this.chatProjectPathDialog = {
			chatId: chat.id,
			chatTitle: chat.title || fallbackTitle,
			currentProjectPath: chat.projectPath,
		};
	}

	showProjectPathDialog(chatId: string, chatTitle: string, currentProjectPath: string): void {
		this.chatProjectPathDialog = { chatId, chatTitle, currentProjectPath };
	}

	closeProjectPathDialog(): void {
		this.chatProjectPathDialog = null;
	}

	requestDetails(chat: ChatSessionRecord, fallbackTitle: string): void {
		this.showDetails(chat.id, chat.title || fallbackTitle);
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

	requestTags(chat: ChatSessionRecord, fallbackTitle: string): void {
		this.tagDialog = {
			chatId: chat.id,
			chatTitle: chat.title || fallbackTitle,
			tags: chat.tags,
		};
	}

	showTagDialog(chatId: string, chatTitle: string, tags: string[]): void {
		this.tagDialog = { chatId, chatTitle, tags };
	}

	closeTagDialog(): void {
		this.tagDialog = null;
	}

	requestShare(chat: ChatSessionRecord, fallbackTitle: string): void {
		this.shareChatDialog = {
			chatId: chat.id,
			chatTitle: chat.title || fallbackTitle,
		};
	}

	showShareDialog(chatId: string, chatTitle: string): void {
		this.shareChatDialog = { chatId, chatTitle };
	}

	closeShareDialog(): void {
		this.shareChatDialog = null;
	}
}
