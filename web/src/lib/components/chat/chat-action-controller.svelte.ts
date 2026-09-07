import * as m from '$lib/paraglide/messages.js';
import { SidebarController } from '$lib/components/sidebar/sidebar-controller.svelte';
import type { ChatArchiveMutation } from '$lib/chat/sessions/chat-sessions.svelte';
import type { ChatSessionRecord } from '$lib/types/chat-session';
import type { ChatActionDialogsState } from './chat-action-dialogs-state.svelte';
import type { ChatListEntry } from '$shared/chat-list';

export interface ChatActionControllerDeps {
	get chats(): ChatSessionRecord[];
	get selectedChatId(): string | null;
	onQuietRefresh: () => Promise<void> | void;
	isArchiveMutationPending: (chatId: string) => boolean;
	startArchivingChats: (chatIds: readonly string[]) => ChatArchiveMutation;
	startUnarchivingChats: (chatIds: readonly string[]) => ChatArchiveMutation;
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
			get isArchiveMutationPending() {
				return deps.isArchiveMutationPending;
			},
			get startArchivingChats() {
				return deps.startArchivingChats;
			},
			get startUnarchivingChats() {
				return deps.startUnarchivingChats;
			},
		});
	}

	async togglePinned(chatId: string): Promise<void> {
		if (this.deps.isArchiveMutationPending(chatId)) return;
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
		const chats = this.deps.chats;
		const chatIndex = chats.findIndex((entry) => entry.id === chatId);
		const chat = chats[chatIndex];
		if (!chat || this.deps.isArchiveMutationPending(chatId)) return;
		const wasArchived = chat.isArchived;
		const isSelectedChat = this.deps.selectedChatId === chatId;
		const isArchivingSelectedChat = !wasArchived && isSelectedChat;
		let replacementChatId: string | null = null;
		if (isArchivingSelectedChat) {
			replacementChatId = this.#findArchiveReplacementChatId(chats, chatIndex);
		}

		const mutation = wasArchived
			? this.deps.startUnarchivingChats([chatId])
			: this.deps.startArchivingChats([chatId]);
		if (!mutation.chatIds.includes(chatId)) return;

		if (isArchivingSelectedChat) {
			if (replacementChatId) this.deps.onSelectChat(replacementChatId);
			else this.deps.onNewChat();
		}

		await this.run('Failed to toggle archive:', m.notifications_archive_chat_failed(), async () => {
			await mutation.completion;
			if (wasArchived && this.deps.selectedChatId === chatId) {
				this.deps.requestSidebarRecenter();
			}
		});
	}

	#findArchiveReplacementChatId(
		chats: readonly ChatSessionRecord[],
		chatIndex: number,
	): string | null {
		for (let index = chatIndex + 1; index < chats.length; index += 1) {
			const chat = chats[index];
			if (chat && !this.deps.isArchiveMutationPending(chat.id)) return chat.id;
		}
		for (let index = chatIndex - 1; index >= 0; index -= 1) {
			const chat = chats[index];
			if (chat && !this.deps.isArchiveMutationPending(chat.id)) return chat.id;
		}
		return null;
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
				transcriptSource: details.transcriptSource,
				carryOverSegments: details.carryOver.segments,
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

	private async run(
		logMessage: string,
		userMessage: string,
		fn: () => Promise<void>,
	): Promise<void> {
		try {
			await fn();
		} catch (error) {
			console.error(logMessage, error);
			this.deps.notifyError(userMessage);
		}
	}
}
