import * as m from '$lib/paraglide/messages.js';
import { resolveArchiveReplacementChatId } from '$lib/chat/actions/archive-navigation';
import { SidebarController } from '$lib/components/sidebar/sidebar-controller.svelte';
import type { ChatArchiveMutation } from '$lib/chat/sessions/chat-sessions-contract';
import type { ChatSessionRecord } from '$lib/types/chat-session';
import type {
	ChatActionDialogsState,
	ChatProjectPathDialog,
} from './chat-action-dialogs-state.svelte';
import { updateChatProjectPath } from '$lib/api/chats.js';
import { resolveProject } from '$lib/api/project-resolution.js';
import { effectiveExecutorId } from '$shared/executors';
import type { ChatListEntry } from '$shared/chat-list';
import type { ChatTagsMutationResponse } from '$shared/chat-tag-mutations';

export interface ChatActionControllerDeps {
	get chats(): ChatSessionRecord[];
	get displayedChatIds(): readonly string[];
	get selectedChatId(): string | null;
	projectPathRevision: (chatId: string) => number;
	onQuietRefresh: () => Promise<void> | void;
	isArchiveMutationPending: (chatId: string) => boolean;
	startArchivingChats: (chatIds: readonly string[]) => ChatArchiveMutation;
	startUnarchivingChats: (chatIds: readonly string[]) => ChatArchiveMutation;
	onSelectChat: (chatId: string) => void;
	onNewChat: () => void;
	onDeleteChat: (chatId: string) => Promise<void> | void;
	onRenameChat: (chatId: string, newTitle: string) => Promise<void> | void;
	onProjectPathUpdated: (chatId: string, patch: { projectPath: string }) => void;
	onUpsertServerChat: (entry: ChatListEntry) => void;
	replaceChatTags: (input: {
		chatId: string;
		expectedTags: readonly string[];
		tags: readonly string[];
	}) => Promise<ChatTagsMutationResponse>;
	onReloadChat?: (chatId: string) => Promise<void> | void;
	notifyError: (message: string) => void;
	requestComposerFocus: () => void;
	requestSidebarRecenter: () => void;
}

export class ChatActionController {
	#sidebarController: SidebarController;
	#projectPathRequestGeneration = new Map<string, symbol>();

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
		const chat = this.deps.chats.find((entry) => entry.id === chatId);
		if (!chat || this.deps.isArchiveMutationPending(chatId)) return;
		const wasArchived = chat.isArchived;
		const isArchivingSelectedChat = !wasArchived && this.deps.selectedChatId === chatId;
		let replacementChatId: string | null = null;
		if (isArchivingSelectedChat) {
			replacementChatId = resolveArchiveReplacementChatId({
				archivingChatId: chatId,
				displayedChatIds: this.deps.displayedChatIds,
				isSelectableChat: (candidateId) => !this.deps.isArchiveMutationPending(candidateId),
			});
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

	async updateTags(
		chatId: string,
		baseTags: readonly string[],
		tags: readonly string[],
	): Promise<void> {
		await this.deps.replaceChatTags({ chatId, expectedTags: baseTags, tags });
	}

	async updateProjectPath(target: ChatProjectPathDialog, projectPath: string): Promise<void> {
		const { chatId, currentProjectPath: expectedProjectPath } = target;
		const executorId = effectiveExecutorId(target.executorId);
		const matchesOwner = (chat: ChatSessionRecord | undefined) =>
			chat?.status === target.status &&
			chat.agentOwnershipEpoch === target.agentOwnershipEpoch &&
			effectiveExecutorId(chat.executorId) === executorId;
		const chat = this.deps.chats.find((entry) => entry.id === chatId);
		if (!matchesOwner(chat) || chat?.projectPath !== expectedProjectPath) {
			throw new Error(m.sidebar_project_path_errors_target_changed());
		}
		const expectedRevision = this.deps.projectPathRevision(chatId);
		const generation = Symbol();
		this.#projectPathRequestGeneration.set(chatId, generation);
		let nextPath: string;
		try {
			if (target.status === 'draft') {
				const result = await resolveProject(
					{ kind: 'path', executorId, projectPath: projectPath.trim() },
					new AbortController().signal,
				);
				if (result.resolution.kind !== 'available')
					throw new Error(m.workspace_project_unavailable());
				nextPath = result.resolution.effectiveProjectKey;
			} else {
				if (!target.agentOwnershipEpoch)
					throw new Error(m.sidebar_project_path_errors_target_changed());
				const result = await updateChatProjectPath({
					chatId,
					projectPath,
					expectedProjectPath,
					expectedExecutorId: executorId,
					expectedAgentOwnershipEpoch: target.agentOwnershipEpoch,
				});
				nextPath = result.projectPath;
			}
			if (this.#projectPathRequestGeneration.get(chatId) !== generation) return;
		} finally {
			if (this.#projectPathRequestGeneration.get(chatId) === generation) {
				this.#projectPathRequestGeneration.delete(chatId);
			}
		}
		const current = this.deps.chats.find((entry) => entry.id === chatId);
		if (!matchesOwner(current)) return;
		const currentProjectPath = current?.projectPath;
		if (
			currentProjectPath !== nextPath &&
			(currentProjectPath !== expectedProjectPath ||
				this.deps.projectPathRevision(chatId) !== expectedRevision)
		)
			return;
		this.deps.onProjectPathUpdated(chatId, {
			projectPath: nextPath,
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
