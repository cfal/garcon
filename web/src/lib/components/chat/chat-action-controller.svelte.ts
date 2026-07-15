import * as m from '$lib/paraglide/messages.js';
import { SidebarController } from '$lib/components/sidebar/sidebar-controller.svelte';
import type { ChatSessionRecord } from '$lib/types/chat-session';
import type { ChatActionDialogsState } from './chat-action-dialogs-state.svelte';
import type { ChatListEntry } from '$shared/chat-list';

export interface ChatActionControllerDeps {
	get chats(): ChatSessionRecord[];
	get selectedChatId(): string | null;
	onQuietRefresh: () => Promise<void> | void;
	onSelectChat: (chatId: string) => void;
	onNewChat: () => void;
	onDeleteChat: (chatId: string) => Promise<void> | void;
	onRenameChat: (chatId: string, newTitle: string) => Promise<void> | void;
	onProjectPathUpdated: (
		chatId: string,
		patch: { projectPath: string; effectiveProjectKey: string },
	) => void;
	onUpsertServerChat: (entry: ChatListEntry) => void;
	onReloadChat?: (chatId: string) => Promise<void> | void;
	notifyError: (message: string) => void;
	requestComposerFocus: () => void;
	requestSidebarRecenter: () => void;
}

export class ChatActionController {
	#sidebarController: SidebarController;

	constructor(private readonly deps: ChatActionControllerDeps) {
		this.#sidebarController = new SidebarController({
			get onQuietRefresh() {
				return deps.onQuietRefresh;
			},
		});
	}

	async togglePinned(chatId: string): Promise<void> {
		const chat = this.deps.chats.find((entry) => entry.id === chatId);
		const wasPinned = chat?.isPinned === true;
		await this.run('Failed to toggle pinned:', m.notifications_pin_chat_failed(), async () => {
			await this.#sidebarController.togglePinned(chatId);
			if (!wasPinned && this.deps.selectedChatId === chatId) {
				this.deps.requestSidebarRecenter();
			}
		});
	}

	async toggleArchive(chatId: string): Promise<void> {
		const chat = this.deps.chats.find((entry) => entry.id === chatId);
		const wasArchived = chat?.isArchived === true;
		const isSelectedChat = this.deps.selectedChatId === chatId;
		const isArchivingSelectedChat = !wasArchived && isSelectedChat;
		const chatIndex = this.deps.chats.findIndex((entry) => entry.id === chatId);
		const neighborId =
			isArchivingSelectedChat && chatIndex >= 0
				? (this.deps.chats[chatIndex + 1]?.id ?? this.deps.chats[chatIndex - 1]?.id ?? null)
				: null;

		await this.run('Failed to toggle archive:', m.notifications_archive_chat_failed(), async () => {
			await this.#sidebarController.toggleArchive(chatId);
			if (isArchivingSelectedChat) {
				if (neighborId) this.deps.onSelectChat(neighborId);
				else this.deps.onNewChat();
				return;
			}
			if (wasArchived && isSelectedChat) {
				this.deps.requestSidebarRecenter();
			}
		});
	}

	async confirmDelete(dialogs: ChatActionDialogsState): Promise<void> {
		const confirmation = dialogs.chatDeleteConfirmation;
		if (!confirmation) return;
		dialogs.clearDeleteConfirmation();
		await this.deps.onDeleteChat(confirmation.chatId);
	}

	async confirmRename(dialogs: ChatActionDialogsState, newName: string): Promise<void> {
		const confirmation = dialogs.chatRenameConfirmation;
		if (!confirmation) return;
		dialogs.clearRename();
		await this.deps.onRenameChat(confirmation.chatId, newName.trim());
		if (confirmation.chatId === this.deps.selectedChatId) {
			this.deps.requestComposerFocus();
		}
	}

	async loadDetails(chatId: string, dialogs: ChatActionDialogsState): Promise<void> {
		try {
			const details = await this.#sidebarController.loadDetails(chatId);
			dialogs.completeDetails(chatId, {
				firstMessage: details.firstMessage,
				createdAt: details.createdAt,
				lastActivityAt: details.lastActivityAt,
				agentSessionId: details.agentSessionId,
				nativePath: details.nativePath,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			dialogs.failDetails(chatId, message || m.sidebar_details_error_loading());
		}
	}

	async updateTags(chatId: string, tags: string[]): Promise<void> {
		await this.#sidebarController.updateTags(chatId, tags);
	}

	async updateProjectPath(chatId: string, projectPath: string): Promise<void> {
		const result = await this.#sidebarController.updateProjectPath(chatId, projectPath);
		this.deps.onProjectPathUpdated(chatId, {
			projectPath: result.projectPath,
			effectiveProjectKey: result.effectiveProjectKey,
		});
	}

	async forkChat(sourceChatId: string): Promise<void> {
		await this.run('Failed to fork chat:', m.notifications_fork_chat_failed(), async () => {
			const entry = await this.#sidebarController.forkChat(sourceChatId);
			this.deps.onUpsertServerChat(entry);
			this.deps.onSelectChat(entry.id);
		});
	}

	async reloadChat(chatId: string): Promise<void> {
		if (!this.deps.onReloadChat) return;
		await this.run(
			'Failed to reload chat from native history:',
			m.sidebar_chats_reload_failed(),
			async () => {
				await this.deps.onReloadChat?.(chatId);
			},
		);
	}

	private async run(logMessage: string, userMessage: string, fn: () => Promise<void>): Promise<void> {
		try {
			await fn();
		} catch (error) {
			console.error(logMessage, error);
			this.deps.notifyError(userMessage);
		}
	}
}
