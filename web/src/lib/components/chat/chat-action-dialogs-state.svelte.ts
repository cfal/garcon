import type { SessionAgentId } from '$lib/types/app';
import type { ChatSessionRecord } from '$lib/types/chat-session';
import type { ChatTranscriptSourceDto } from '$shared/chat-details';

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
	transcriptSource: ChatTranscriptSourceDto | null;
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

	clearDeleteConfirmation(): void {
		this.chatDeleteConfirmation = null;
	}

	requestRename(chat: ChatSessionRecord, fallbackTitle: string): void {
		this.chatRenameConfirmation = {
			chatId: chat.id,
			currentName: chat.title || fallbackTitle,
		};
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

	closeProjectPathDialog(): void {
		this.chatProjectPathDialog = null;
	}

	requestDetails(chat: ChatSessionRecord, fallbackTitle: string): void {
		this.chatDetailsDialog = {
			chatId: chat.id,
			chatTitle: chat.title || fallbackTitle,
			firstMessage: null,
			createdAt: null,
			lastActivityAt: null,
			agentSessionId: null,
			transcriptSource: null,
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
			transcriptSource: ChatTranscriptSourceDto | null;
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

	closeTagDialog(): void {
		this.tagDialog = null;
	}

	requestShare(chat: ChatSessionRecord, fallbackTitle: string): void {
		this.shareChatDialog = {
			chatId: chat.id,
			chatTitle: chat.title || fallbackTitle,
		};
	}

	closeShareDialog(): void {
		this.shareChatDialog = null;
	}
}
