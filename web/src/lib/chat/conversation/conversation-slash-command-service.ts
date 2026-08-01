import { compactChat, forkChat } from '$lib/api/chats.js';
import { ApiError } from '$lib/api/client.js';
import { scheduleChatPrompt } from '$lib/api/scheduled-prompts.js';
import type { ChatImage } from '$shared/chat-types';
import type { ChatListEntry } from '$shared/chat-list';
import type { ApiProtocol } from '$shared/api-providers';
import type { ChatSessionRecord } from '$lib/types/chat-session';
import type { SessionAgentId } from '$lib/types/app';
import type { LocalNoticeType } from '$lib/chat/transcript/local-notice.js';
import { parseForkCommand } from '$lib/chat/composer/fork-command.js';
import {
	parseCompactCommand,
	isGoalCommand,
	parseMoveChatBoundaryCommand,
	parseRenameCommand,
	parseScheduleInCommand,
	parseSteerCommand,
	parseTagCommand,
} from '$lib/chat/composer/slash-commands.js';
import { createClientChatId } from '$lib/chat/sessions/client-chat-id.js';
import { createClientCommandId } from '$lib/chat/conversation/client-command-id.js';
import type {
	ScheduleInCommandError,
	ScheduleInCommandParseResult,
	MoveChatBoundaryCommandParseResult,
	TagCommandParseResult,
} from '$lib/chat/composer/slash-commands.js';
import { formatScheduledInstant } from '$lib/scheduling/local-schedule.js';
import {
	errorDetail,
	prepareChatImages,
} from '$lib/chat/conversation/conversation-submission-helpers.js';
import { CommandOutcomeUnknownError } from '$lib/chat/conversation/idempotent-command.js';
import { AcceptedInputSubmissionService } from '$lib/chat/conversation/accepted-input-submission-service.js';
import {
	remapForkAtMessage,
	selectForkAtMessage,
	type ForkAtMessageSelection,
} from '$lib/chat/actions/fork-at-message-action.js';
import type { ChatViewMessage } from '$shared/chat-view';
import type { ConversationSubmissionOutcome } from './conversation-submission-outcome.js';
import * as m from '$lib/paraglide/messages.js';
import type { ReorderChatResponse } from '$shared/chat-order-contracts';
import { normalizeTags } from '$shared/tags';

interface SlashCommandSessions {
	selectedChatId: string | null;
	byId: Record<string, ChatSessionRecord>;
	renameChat(chatId: string, newTitle: string): Promise<boolean>;
	moveChatToBoundary(
		chatId: string,
		boundary: 'top' | 'bottom',
	): Promise<ReorderChatResponse | null>;
	setChatTags(chatId: string, tags: string[]): Promise<boolean>;
	upsertServerChat(entry: ChatListEntry): void;
	setSelectedChatId(chatId: string | null): void;
}

interface SlashCommandChatState {
	activeChatId: string | null;
	entries: readonly ChatViewMessage[];
	isUserScrolledUp: boolean;
	getCursor(): { generationId: string; lastSeq: number };
	appendLocalNotice(noticeType: LocalNoticeType, content: string): void;
}

interface SlashCommandComposerState {
	inputText: string;
	images: File[];
	readonly contentRevision: number;
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
	supportsFork(agentId: SessionAgentId): boolean;
	supportsForkWhileRunning(agentId: SessionAgentId): boolean;
	supportsSteering(agentId: SessionAgentId): boolean;
	supportsGoals(agentId: SessionAgentId): boolean;
}

export interface ConversationSlashCommandDeps {
	sessions: SlashCommandSessions;
	chatState: SlashCommandChatState;
	composerState: SlashCommandComposerState;
	agentState: SlashCommandAgentState;
	lifecycle: SlashCommandLifecycle;
	modelCatalog: SlashCommandModelCatalog;
	navigation: { navigateToChat?(chatId: string): void };
	refetchTranscript?: (chatId: string) => Promise<void>;
	scrollToBottom(): void;
}

export type SlashCommandSubmissionResolution =
	| { kind: 'handled'; outcome: ConversationSubmissionOutcome | Promise<ConversationSubmissionOutcome> }
	| { kind: 'steer'; content: string }
	| { kind: 'goal-control'; content: string }
	| { kind: 'continue'; content: string };

export class ConversationSlashCommandService {
	readonly #scheduleInFlight = new Set<string>();
	// Serializes each chat's complete incremental tag read-modify-write operation.
	readonly #tagMutationTails = new Map<string, Promise<void>>();

	constructor(
		private readonly deps: ConversationSlashCommandDeps,
		private readonly acceptedInputs = new AcceptedInputSubmissionService(),
	) {}

	dispatchSubmission(input: {
		chatId: string;
		chat: ChatSessionRecord;
		text: string;
		images: File[];
		ownsComposer: boolean;
	}): SlashCommandSubmissionResolution {
		const { chatId, chat, text, images, ownsComposer } = input;
		const rename = parseRenameCommand(text);
		if (rename) {
			return {
				kind: 'handled',
				outcome: this.submitRenameCommand(chatId, chat, rename.title, images, ownsComposer),
			};
		}

		const move = parseMoveChatBoundaryCommand(text);
		if (move.kind !== 'not-command') {
			return {
				kind: 'handled',
				outcome: this.submitMoveChatBoundaryCommand(
					chatId,
					chat,
					move,
					images,
					ownsComposer,
				),
			};
		}

		const tag = parseTagCommand(text);
		if (tag.kind !== 'not-command') {
			return {
				kind: 'handled',
				outcome: this.submitTagCommand(chatId, chat, tag, images, ownsComposer),
			};
		}

		const schedule = parseScheduleInCommand(text);
		if (schedule.kind !== 'not-command') {
			return {
				kind: 'handled',
				outcome: this.submitScheduleInCommand(chatId, chat, schedule, images, ownsComposer),
			};
		}

		const agentId = chat.agentId as SessionAgentId;
		const steer = parseSteerCommand(text);
		if (steer.kind === 'invalid') {
			this.deps.chatState.appendLocalNotice('error', m.chat_notice_steer_prompt_required());
			return { kind: 'handled', outcome: 'rejected' };
		}
		if (steer.kind === 'valid' && !this.deps.modelCatalog.supportsSteering(agentId)) {
			this.deps.chatState.appendLocalNotice('error', m.chat_notice_steer_unsupported());
			return { kind: 'handled', outcome: 'rejected' };
		}
		if (steer.kind === 'valid' && images.length > 0) {
			this.deps.chatState.appendLocalNotice('error', m.chat_notice_steer_attachments_unavailable());
			return { kind: 'handled', outcome: 'rejected' };
		}
		if (steer.kind === 'valid') return { kind: 'steer', content: steer.prompt };

		if (
			isGoalCommand(text)
			&& chat.status === 'running'
			&& chat.isProcessing
			&& this.deps.modelCatalog.supportsGoals(agentId)
		) {
			if (images.length > 0) {
				this.deps.chatState.appendLocalNotice('error', m.chat_notice_queue_attachments_unavailable());
				return { kind: 'handled', outcome: 'rejected' };
			}
			return { kind: 'goal-control', content: text };
		}

		if (this.deps.modelCatalog.supportsFork(agentId)) {
			const fork = parseForkCommand(text);
			if (fork) {
				if (
					chat.status === 'running'
					&& chat.isProcessing
					&& !this.deps.modelCatalog.supportsForkWhileRunning(agentId)
				) {
					this.deps.chatState.appendLocalNotice('error', m.chat_notice_cannot_fork_processing());
					return { kind: 'handled', outcome: 'rejected' };
				}
				return {
					kind: 'handled',
					outcome: this.submitForkCommand(
						chatId,
						chat,
						fork.message,
						images,
						ownsComposer,
					),
				};
			}
		}

		const compact = parseCompactCommand(text);
		if (compact) {
			return {
				kind: 'handled',
				outcome: this.submitCompactCommand(chatId, chat, compact.instructions, ownsComposer),
			};
		}

		return {
			kind: 'continue',
			content: text,
		};
	}

	async submitScheduleInCommand(
		chatId: string,
		chat: ChatSessionRecord,
		command: ScheduleInCommandParseResult,
		images: File[],
		ownsComposer: boolean,
	): Promise<ConversationSubmissionOutcome> {
		const { deps } = this;
		if (command.kind === 'invalid') {
			deps.chatState.appendLocalNotice('error', scheduleInErrorMessage(command.error));
			return 'rejected';
		}
		if (command.kind !== 'valid') return 'no-op';
		if (chat.status === 'draft') {
			deps.chatState.appendLocalNotice('error', m.chat_notice_schedule_in_draft());
			return 'rejected';
		}
		if (images.length > 0) {
			deps.chatState.appendLocalNotice('error', m.chat_notice_schedule_in_attachments());
			return 'rejected';
		}
		if (this.#scheduleInFlight.has(chatId)) return 'no-op';

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
			return 'accepted';
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
			return 'rejected';
		} finally {
			this.#scheduleInFlight.delete(chatId);
		}
	}

	async submitRenameCommand(
		chatId: string,
		chat: ChatSessionRecord,
		title: string,
		images: File[],
		ownsComposer: boolean,
	): Promise<ConversationSubmissionOutcome> {
		const { deps } = this;
		if (!title) {
			deps.chatState.appendLocalNotice('error', m.chat_notice_rename_title_required());
			return 'rejected';
		}
		if (chat.status !== 'running') {
			deps.chatState.appendLocalNotice('error', m.chat_notice_cannot_rename_draft());
			return 'rejected';
		}
		if (images.length > 0) {
			deps.chatState.appendLocalNotice('error', m.chat_notice_rename_attachments());
			return 'rejected';
		}

		const previousText = deps.composerState.inputText;
		const previousImages = [...deps.composerState.images];
		if (ownsComposer) deps.composerState.clearAfterSubmit(chatId);
		const clearedContentRevision = deps.composerState.contentRevision;
		const renamed = await deps.sessions.renameChat(chatId, title);
		if (!renamed) {
			this.#restoreComposerIfUntouched({
				chatId,
				ownsComposer,
				text: previousText,
				images: previousImages,
				clearedContentRevision,
			});
		}
		return renamed ? 'accepted' : 'rejected';
	}

	async submitMoveChatBoundaryCommand(
		chatId: string,
		chat: ChatSessionRecord,
		command: MoveChatBoundaryCommandParseResult,
		images: File[],
		ownsComposer: boolean,
	): Promise<ConversationSubmissionOutcome> {
		const { deps } = this;
		if (command.kind === 'invalid') {
			deps.chatState.appendLocalNotice('error', m.chat_notice_move_arguments());
			return 'rejected';
		}
		if (command.kind !== 'valid') return 'no-op';
		if (chat.status === 'draft') {
			deps.chatState.appendLocalNotice('error', m.chat_notice_move_draft());
			return 'rejected';
		}
		if (images.length > 0) {
			deps.chatState.appendLocalNotice('error', m.chat_notice_move_attachments());
			return 'rejected';
		}

		const previousText = deps.composerState.inputText;
		const previousImages = [...deps.composerState.images];
		if (ownsComposer) deps.composerState.clearAfterSubmit(chatId);
		const clearedContentRevision = deps.composerState.contentRevision;
		const result = await deps.sessions.moveChatToBoundary(chatId, command.boundary);
		if (!result) {
			this.#restoreComposerIfUntouched({
				chatId,
				ownsComposer,
				text: previousText,
				images: previousImages,
				clearedContentRevision,
			});
			return 'rejected';
		}

		if (deps.chatState.activeChatId === chatId) {
			deps.chatState.appendLocalNotice(
				'info',
				moveChatNotice(command.boundary, result.changed),
			);
			deps.chatState.isUserScrolledUp = false;
			deps.scrollToBottom();
		}
		return 'accepted';
	}

	async submitTagCommand(
		chatId: string,
		chat: ChatSessionRecord,
		command: TagCommandParseResult,
		images: File[],
		ownsComposer: boolean,
	): Promise<ConversationSubmissionOutcome> {
		const { deps } = this;
		if (command.kind === 'invalid') {
			deps.chatState.appendLocalNotice('error', m.chat_notice_tag_arguments());
			return 'rejected';
		}
		if (command.kind !== 'valid') return 'no-op';
		if (images.length > 0) {
			deps.chatState.appendLocalNotice('error', m.chat_notice_tag_attachments());
			return 'rejected';
		}

		const previousText = deps.composerState.inputText;
		const previousImages = [...deps.composerState.images];
		if (ownsComposer) deps.composerState.clearAfterSubmit(chatId);
		const clearedContentRevision = deps.composerState.contentRevision;

		return this.#enqueueTagMutation(chatId, async () => {
			const currentTags = normalizeTags(deps.sessions.byId[chatId]?.tags ?? chat.tags);
			const requested = new Set(command.tags);
			const nextTags =
				command.action === 'add'
					? normalizeTags([...currentTags, ...command.tags])
					: currentTags.filter((tag) => !requested.has(tag));
			const changedTags =
				command.action === 'add'
					? nextTags.filter((tag) => !currentTags.includes(tag))
					: currentTags.filter((tag) => !nextTags.includes(tag));
			const updated =
				changedTags.length === 0 ? true : await deps.sessions.setChatTags(chatId, nextTags);
			if (!updated) {
				this.#restoreComposerIfUntouched({
					chatId,
					ownsComposer,
					text: previousText,
					images: previousImages,
					clearedContentRevision,
				});
				return 'rejected';
			}

			if (deps.chatState.activeChatId === chatId) {
				const content =
					changedTags.length === 0
						? m.chat_notice_tags_unchanged()
						: command.action === 'add'
							? m.chat_notice_tags_added({ tags: changedTags.join(', ') })
							: m.chat_notice_tags_removed({ tags: changedTags.join(', ') });
				deps.chatState.appendLocalNotice('info', content);
				deps.chatState.isUserScrolledUp = false;
				deps.scrollToBottom();
			}
			return 'accepted';
		});
	}

	#enqueueTagMutation(
		chatId: string,
		mutation: () => Promise<ConversationSubmissionOutcome>,
	): Promise<ConversationSubmissionOutcome> {
		const previous = this.#tagMutationTails.get(chatId) ?? Promise.resolve();
		const result = previous.then(mutation, mutation);
		const settled = result.then(
			() => undefined,
			() => undefined,
		);
		this.#tagMutationTails.set(chatId, settled);
		void settled.then(() => {
			if (this.#tagMutationTails.get(chatId) === settled) this.#tagMutationTails.delete(chatId);
		});
		return result;
	}

	#restoreComposerIfUntouched(input: {
		chatId: string;
		ownsComposer: boolean;
		text: string;
		images: File[];
		clearedContentRevision: number;
	}): void {
		const { deps } = this;
		if (!input.ownsComposer || deps.sessions.selectedChatId !== input.chatId) return;
		if (deps.composerState.contentRevision !== input.clearedContentRevision) return;
		if (deps.composerState.inputText !== '' || deps.composerState.images.length !== 0) return;
		deps.composerState.inputText = input.text;
		deps.composerState.images = [...input.images];
		deps.composerState.saveDraft(input.chatId);
	}

	async submitCompactCommand(
		chatId: string,
		chat: ChatSessionRecord,
		instructions: string,
		clearComposer: boolean,
	): Promise<ConversationSubmissionOutcome> {
		const { deps } = this;
		if (chat.status !== 'running') {
			deps.chatState.appendLocalNotice('error', m.chat_notice_cannot_compact_draft());
			return 'rejected';
		}

		const previousText = deps.composerState.inputText;
		if (clearComposer) deps.composerState.clearAfterSubmit(chatId);

		try {
			await compactChat({
				chatId,
				clientRequestId: createClientCommandId(),
				instructions: instructions || undefined,
			});
			return 'accepted';
		} catch (error) {
			if (clearComposer) {
				deps.composerState.inputText = previousText;
				deps.composerState.saveDraft(chatId);
			}
			deps.chatState.appendLocalNotice(
				'error',
				m.chat_notice_failed_compact({ detail: errorDetail(error) }),
			);
			return 'rejected';
		}
	}

	async submitForkCommand(
		sourceChatId: string,
		sourceChat: ChatSessionRecord,
		message: string,
		images: File[],
		clearComposer: boolean,
	): Promise<ConversationSubmissionOutcome> {
		const { deps } = this;
		if (sourceChat.status !== 'running') {
			deps.chatState.appendLocalNotice('error', m.chat_notice_cannot_fork_draft());
			return 'rejected';
		}

		const previousText = deps.composerState.inputText;
		const previousImages = [...deps.composerState.images];
		deps.chatState.appendLocalNotice('progress', m.chat_notice_forking_chat());
		deps.chatState.isUserScrolledUp = false;
		if (clearComposer) deps.composerState.clearAfterSubmit(sourceChatId);

		if (!message.trim()) {
			return this.#submitForkOnlyCommand(sourceChatId, previousText, previousImages, clearComposer);
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
				return 'rejected';
			}
		}

		const forkChatId = createClientChatId();
		const model = sourceChat.model ?? deps.agentState.model;
		const selection = deps.modelCatalog.selectionFor(
			sourceChat.agentId,
			model,
			sourceChat.modelEndpointId,
		);
		const submission = this.acceptedInputs.fork({
			sourceChatId,
			chatId: forkChatId,
			command: message.trim(),
			permissionMode: sourceChat.permissionMode,
			thinkingMode: sourceChat.thinkingMode,
			agentSettings: sourceChat.agentSettings,
			images: imagePayload.length > 0 ? imagePayload : undefined,
			model: selection.model,
			apiProviderId: selection.apiProviderId,
			modelEndpointId: selection.modelEndpointId,
			modelProtocol: selection.modelProtocol,
		});
		try {
			const response = await submission.submit();
			deps.sessions.upsertServerChat(response.chat);
			deps.sessions.setSelectedChatId(response.chat.id);
			deps.navigation.navigateToChat?.(response.chat.id);
			if (response.status === 'accepted') {
				deps.lifecycle.beginTurn(response.chat.id);
			}
			return 'accepted';
		} catch (error) {
			const outcomeUnknown = error instanceof CommandOutcomeUnknownError;
			if (!outcomeUnknown) {
				this.#restoreComposer(sourceChatId, previousText, previousImages, clearComposer);
			}
			deps.chatState.appendLocalNotice(
				'error',
				outcomeUnknown
					? m.chat_notice_fork_outcome_unconfirmed()
					: m.chat_notice_failed_fork_chat({ detail: errorDetail(error) }),
			);
			return outcomeUnknown ? 'unknown' : 'rejected';
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
				forkFailureNotice(error),
			);
		}
	}

	async #performForkOnly(sourceChatId: string, upToSeq?: number): Promise<void> {
		const chatId = createClientChatId();
		const selection = upToSeq === undefined
			? null
			: selectForkAtMessage(
				this.deps.chatState.entries,
				this.deps.chatState.getCursor().generationId,
				upToSeq,
			);
		if (upToSeq !== undefined && !selection) {
			throw new Error(m.chat_notice_fork_message_no_longer_available());
		}
		let result: Awaited<ReturnType<typeof forkChat>>;
		try {
			result = await forkChat({
				sourceChatId,
				chatId,
				...(selection ? forkPointParams(selection) : {}),
			});
		} catch (error) {
			if (!selection || !isStaleForkPointError(error) || !this.deps.refetchTranscript) {
				throw error;
			}
			try {
				await this.deps.refetchTranscript(sourceChatId);
			} catch {
				throw error;
			}
			const remapped = remapForkAtMessage(
				this.deps.chatState.entries,
				this.deps.chatState.getCursor().generationId,
				selection,
			);
			if (!remapped) throw error;
			result = await forkChat({
				sourceChatId,
				chatId,
				...forkPointParams(remapped),
			});
		}
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
	): Promise<ConversationSubmissionOutcome> {
		try {
			await this.#performForkOnly(sourceChatId);
			return 'accepted';
		} catch (error) {
			this.#restoreComposer(sourceChatId, previousText, previousImages, restoreComposer);
			this.deps.chatState.appendLocalNotice(
				'error',
				forkFailureNotice(error),
			);
			return 'rejected';
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

function forkPointParams(selection: ForkAtMessageSelection): {
	upToSeq: number;
	generationId: string;
} {
	return {
		upToSeq: selection.seq,
		generationId: selection.generationId,
	};
}

function isStaleForkPointError(error: unknown): error is ApiError {
	return error instanceof ApiError
		&& error.errorCode === 'STALE_VIEW_GENERATION';
}

// A fork point the server could not resolve against native history is a recoverable state the
// user can act on, so it reads as its own notice instead of a generic fork failure.
function forkFailureNotice(error: unknown): string {
	return error instanceof ApiError && error.errorCode === 'MESSAGE_NOT_IN_NATIVE_HISTORY'
		? m.chat_notice_fork_message_not_in_native_history()
		: m.chat_notice_failed_fork_chat({ detail: errorDetail(error) });
}

function moveChatNotice(boundary: 'top' | 'bottom', changed: boolean): string {
	if (boundary === 'top') {
		return changed
			? m.chat_notice_move_top_success()
			: m.chat_notice_move_top_unchanged();
	}
	return changed
		? m.chat_notice_move_bottom_success()
		: m.chat_notice_move_bottom_unchanged();
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
