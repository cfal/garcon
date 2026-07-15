import { compactChat, forkChat, forkRunChat } from '$lib/api/chats.js';
import { scheduleChatPrompt } from '$lib/api/scheduled-prompts.js';
import type { ChatImage } from '$shared/chat-types';
import type { ChatListEntry } from '$shared/chat-list';
import type { ApiProtocol } from '$shared/api-providers';
import type { ChatSessionRecord } from '$lib/types/chat-session';
import type { SessionAgentId } from '$lib/types/app';
import type { LocalNoticeType } from '$lib/chat/transcript/local-notice.js';
import { createClientChatId } from '$lib/chat/sessions/client-chat-id.js';
import { createClientCommandId } from '$lib/chat/conversation/client-command-id.js';
import type {
	ScheduleInCommandError,
	ScheduleInCommandParseResult,
} from '$lib/chat/composer/slash-commands.js';
import { formatScheduledInstant } from '$lib/scheduling/local-schedule.js';
import {
	errorDetail,
	prepareChatImages,
} from '$lib/chat/conversation/conversation-submission-helpers.js';
import * as m from '$lib/paraglide/messages.js';

interface SlashCommandSessions {
	selectedChatId: string | null;
	byId: Record<string, ChatSessionRecord>;
	renameChat(chatId: string, newTitle: string): Promise<boolean>;
	upsertServerChat(entry: ChatListEntry): void;
	setSelectedChatId(chatId: string | null): void;
	setChatProcessing(chatId: string, isProcessing: boolean): void;
}

interface SlashCommandChatState {
	activeChatId: string | null;
	isUserScrolledUp: boolean;
	appendLocalNotice(noticeType: LocalNoticeType, content: string): void;
}

interface SlashCommandComposerState {
	inputText: string;
	images: File[];
	clearAfterSubmit(chatId: string): void;
	saveDraft(chatId: string): void;
}

interface SlashCommandAgentState {
	model: string;
}

interface SlashCommandLifecycle {
	beginTurn(chatId: string): void;
	setCurrentChatId(chatId: string | null): void;
}

interface SlashCommandModelCatalog {
	selectionFor(
		agentId: SessionAgentId,
		model: string,
		modelEndpointId?: string | null,
	): {
		model: string;
		apiProviderId: string | null;
		modelEndpointId: string | null;
		modelProtocol: ApiProtocol | null;
	};
}

export interface ConversationSlashCommandDeps {
	sessions: SlashCommandSessions;
	chatState: SlashCommandChatState;
	composerState: SlashCommandComposerState;
	agentState: SlashCommandAgentState;
	lifecycle: SlashCommandLifecycle;
	modelCatalog: SlashCommandModelCatalog;
	navigation: { navigateToChat?(chatId: string): void };
	scrollToBottom(): void;
}

export class ConversationSlashCommandService {
	readonly #scheduleInFlight = new Set<string>();

	constructor(private readonly deps: ConversationSlashCommandDeps) {}

	async submitScheduleInCommand(
		chatId: string,
		chat: ChatSessionRecord,
		command: ScheduleInCommandParseResult,
		images: File[],
		ownsComposer: boolean,
	): Promise<void> {
		const { deps } = this;
		if (command.kind === 'invalid') {
			deps.chatState.appendLocalNotice('error', scheduleInErrorMessage(command.error));
			return;
		}
		if (command.kind !== 'valid') return;
		if (chat.status === 'draft') {
			deps.chatState.appendLocalNotice('error', m.chat_notice_schedule_in_draft());
			return;
		}
		if (images.length > 0) {
			deps.chatState.appendLocalNotice('error', m.chat_notice_schedule_in_attachments());
			return;
		}
		if (this.#scheduleInFlight.has(chatId)) return;

		this.#scheduleInFlight.add(chatId);
		const previousText = deps.composerState.inputText;
		if (ownsComposer) deps.composerState.clearAfterSubmit(chatId);
		try {
			const result = await scheduleChatPrompt({
				chatId,
				duration: command.duration,
				prompt: command.prompt,
			});
			if (deps.chatState.activeChatId === chatId) {
				deps.chatState.appendLocalNotice(
					'info',
					m.chat_notice_schedule_in_success({
						time: formatScheduledInstant(result.scheduledPrompt.schedule.nextRunAt),
					}),
				);
				deps.chatState.isUserScrolledUp = false;
				deps.scrollToBottom();
			}
		} catch (error) {
			if (ownsComposer && deps.sessions.selectedChatId === chatId) {
				deps.composerState.inputText = previousText;
				deps.composerState.saveDraft(chatId);
			}
			if (deps.chatState.activeChatId === chatId) {
				deps.chatState.appendLocalNotice(
					'error',
					m.chat_notice_schedule_in_failed({ detail: errorDetail(error) }),
				);
			}
		} finally {
			this.#scheduleInFlight.delete(chatId);
		}
	}

	async submitRenameCommand(
		chatId: string,
		chat: ChatSessionRecord,
		title: string,
		images: File[],
		clearComposer: boolean,
	): Promise<void> {
		const { deps } = this;
		if (!title) {
			deps.chatState.appendLocalNotice('error', m.chat_notice_rename_title_required());
			return;
		}
		if (chat.status !== 'running') {
			deps.chatState.appendLocalNotice('error', m.chat_notice_cannot_rename_draft());
			return;
		}
		if (images.length > 0) {
			deps.chatState.appendLocalNotice('error', m.chat_notice_rename_attachments());
			return;
		}

		const previousText = deps.composerState.inputText;
		const previousImages = [...deps.composerState.images];
		if (clearComposer) deps.composerState.clearAfterSubmit(chatId);
		const renamed = await deps.sessions.renameChat(chatId, title);
		if (!renamed && clearComposer && deps.sessions.selectedChatId === chatId) {
			deps.composerState.inputText = previousText;
			deps.composerState.images = previousImages;
			deps.composerState.saveDraft(chatId);
		}
	}

	async submitCompactCommand(
		chatId: string,
		chat: ChatSessionRecord,
		instructions: string,
		clearComposer: boolean,
	): Promise<void> {
		const { deps } = this;
		if (chat.status !== 'running') {
			deps.chatState.appendLocalNotice('error', m.chat_notice_cannot_compact_draft());
			return;
		}

		const previousText = deps.composerState.inputText;
		if (clearComposer) deps.composerState.clearAfterSubmit(chatId);

		try {
			await compactChat({
				chatId,
				clientRequestId: createClientCommandId(),
				instructions: instructions || undefined,
			});
		} catch (error) {
			if (clearComposer) {
				deps.composerState.inputText = previousText;
				deps.composerState.saveDraft(chatId);
			}
			deps.chatState.appendLocalNotice(
				'error',
				m.chat_notice_failed_compact({ detail: errorDetail(error) }),
			);
		}
	}

	async submitForkCommand(
		sourceChatId: string,
		sourceChat: ChatSessionRecord,
		message: string,
		images: File[],
		clearComposer: boolean,
	): Promise<void> {
		const { deps } = this;
		if (sourceChat.status !== 'running') {
			deps.chatState.appendLocalNotice('error', m.chat_notice_cannot_fork_draft());
			return;
		}

		const previousText = deps.composerState.inputText;
		const previousImages = [...deps.composerState.images];
		deps.chatState.appendLocalNotice('progress', m.chat_notice_forking_chat());
		deps.chatState.isUserScrolledUp = false;
		if (clearComposer) deps.composerState.clearAfterSubmit(sourceChatId);

		if (!message.trim()) {
			await this.#submitForkOnlyCommand(sourceChatId, previousText, previousImages, clearComposer);
			return;
		}

		let imagePayload: ChatImage[] = [];
		if (images.length > 0) {
			try {
				imagePayload = await prepareChatImages(images);
			} catch (error) {
				this.#restoreComposer(sourceChatId, previousText, previousImages, clearComposer);
				deps.chatState.appendLocalNotice(
					'error',
					m.chat_notice_failed_prepare_attachments({ detail: errorDetail(error) }),
				);
				return;
			}
		}

		const forkChatId = createClientChatId();
		const model = sourceChat.model ?? deps.agentState.model;
		const selection = deps.modelCatalog.selectionFor(
			sourceChat.agentId,
			model,
			sourceChat.modelEndpointId,
		);
		try {
			const response = await forkRunChat({
				clientRequestId: createClientCommandId(),
				clientMessageId: createClientCommandId(),
				sourceChatId,
				chatId: forkChatId,
				command: message.trim(),
				permissionMode: sourceChat.permissionMode,
				thinkingMode: sourceChat.thinkingMode,
				claudeThinkingMode: sourceChat.claudeThinkingMode,
				ampAgentMode: sourceChat.ampAgentMode,
				images: imagePayload.length > 0 ? imagePayload : undefined,
				model: selection.model,
				apiProviderId: selection.apiProviderId,
				modelEndpointId: selection.modelEndpointId,
				modelProtocol: selection.modelProtocol,
			});
			deps.sessions.upsertServerChat(response.chat);
			deps.sessions.setSelectedChatId(response.chat.id);
			deps.navigation.navigateToChat?.(response.chat.id);
			if (response.status === 'accepted') {
				deps.lifecycle.beginTurn(response.chat.id);
				deps.sessions.setChatProcessing(response.chat.id, true);
			}
		} catch (error) {
			this.#restoreComposer(sourceChatId, previousText, previousImages, clearComposer);
			deps.chatState.appendLocalNotice(
				'error',
				m.chat_notice_failed_fork_chat({ detail: errorDetail(error) }),
			);
		}
	}

	async forkChat(sourceChatId: string, upToSeq?: number): Promise<void> {
		const sourceChat = this.deps.sessions.byId[sourceChatId];
		if (!sourceChat || sourceChat.status === 'draft') {
			this.deps.chatState.appendLocalNotice('error', m.chat_notice_cannot_fork_draft());
			return;
		}
		try {
			await this.#performForkOnly(sourceChatId, upToSeq);
		} catch (error) {
			this.deps.chatState.appendLocalNotice(
				'error',
				m.chat_notice_failed_fork_chat({ detail: errorDetail(error) }),
			);
		}
	}

	async #performForkOnly(sourceChatId: string, upToSeq?: number): Promise<void> {
		const result = await forkChat({
			sourceChatId,
			chatId: createClientChatId(),
			...(upToSeq ? { upToSeq } : {}),
		});
		this.deps.sessions.upsertServerChat(result.chat);
		this.deps.lifecycle.setCurrentChatId(result.chat.id);
		this.deps.sessions.setSelectedChatId(result.chat.id);
		this.deps.navigation.navigateToChat?.(result.chat.id);
	}

	async #submitForkOnlyCommand(
		sourceChatId: string,
		previousText: string,
		previousImages: File[],
		restoreComposer: boolean,
	): Promise<void> {
		try {
			await this.#performForkOnly(sourceChatId);
		} catch (error) {
			this.#restoreComposer(sourceChatId, previousText, previousImages, restoreComposer);
			this.deps.chatState.appendLocalNotice(
				'error',
				m.chat_notice_failed_fork_chat({ detail: errorDetail(error) }),
			);
		}
	}

	#restoreComposer(
		chatId: string,
		previousText: string,
		previousImages: File[],
		restore: boolean,
	): void {
		if (!restore) return;
		this.deps.composerState.inputText = previousText;
		this.deps.composerState.images = previousImages;
		this.deps.composerState.saveDraft(chatId);
	}
}

function scheduleInErrorMessage(error: ScheduleInCommandError): string {
	switch (error) {
		case 'missing':
			return m.chat_notice_schedule_in_duration_required();
		case 'sub-minute-unsupported':
			return m.chat_notice_schedule_in_sub_minute_unsupported();
		case 'invalid-format':
			return m.chat_notice_schedule_in_duration_invalid();
		case 'too-short':
			return m.chat_notice_schedule_in_duration_too_short();
		case 'too-long':
			return m.chat_notice_schedule_in_duration_too_long();
		case 'prompt-required':
			return m.chat_notice_schedule_in_prompt_required();
		case 'slash-prompt-unsupported':
			return m.chat_notice_schedule_in_slash_prompt_unsupported();
	}
}
