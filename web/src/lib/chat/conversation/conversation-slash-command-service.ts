import { compactChat } from '$lib/api/chats.js';
import { ApiMutationOutcomeUnknownError } from '$lib/api/client.js';
import { scheduleChatPrompt } from '$lib/api/scheduled-prompts.js';
import type { ScheduledPromptExecutionSelection } from '$shared/scheduled-prompts';
import type { ChatListEntry } from '$shared/chat-list';
import type { ApiProtocol } from '$shared/api-providers';
import { effectiveExecutorId } from '$shared/executors';
import { ConversationForkHandoffService } from './conversation-fork-handoff-service.js';
import {
	steerSubmissionRejection,
	steerSubmissionRejectionNotice,
} from './steer-submission-policy.js';
import type { ChatSessionRecord, SessionAgentId } from '$lib/chat/sessions/chat-session-types';
import type { LocalNoticeType } from '$lib/chat/transcript/local-notice.js';
import { parseForkCommand } from '$lib/chat/composer/fork-command.js';
import { parseHandoffCommand } from '$lib/chat/composer/handoff-command.js';
import {
	parseCompactCommand,
	parseMoveChatBoundaryCommand,
	parseRenameCommand,
	parseScheduleInCommand,
	parseSteerCommand,
	parseTagCommand,
	isLiteralAppCommand,
} from '$lib/chat/composer/slash-commands.js';
import { createClientCommandId } from '$lib/chat/conversation/client-command-id.js';
import type {
	ScheduleInCommandError,
	ScheduleInCommandParseResult,
	MoveChatBoundaryCommandParseResult,
	TagCommandParseResult,
} from '$lib/chat/composer/slash-commands.js';
import { formatScheduledInstant } from '$lib/scheduling/local-schedule.js';
import { errorDetail } from '$lib/chat/conversation/conversation-submission-helpers.js';
import { AcceptedInputSubmissionService } from '$lib/chat/conversation/accepted-input-submission-service.js';
import type { TranscriptMessage } from '$shared/chat-view';
import type { ConversationSubmissionOutcome } from './conversation-submission-outcome.js';
import * as m from '$lib/paraglide/messages.js';
import type { SidebarOrderController } from '$lib/sidebar/display/sidebar-order-controller.svelte.js';
import type {
	ApplyChatTagDeltaRequest,
	ChatTagsMutationResponse,
} from '$shared/chat-tag-mutations';
import type { ChatTagReconciliationKind } from '$lib/chat/sessions/chat-sessions-contract.js';
import { ChatTagMutationBlockedError } from '$lib/chat/sessions/chat-tag-mutation-result.js';

interface SlashCommandSessions {
	selectedChatId: string | null;
	byId: Record<string, ChatSessionRecord>;
	renameChat(chatId: string, newTitle: string): Promise<boolean>;
	tagReconciliationKind(chatId: string): ChatTagReconciliationKind;
	applyChatTagDelta(request: ApplyChatTagDeltaRequest): Promise<ChatTagsMutationResponse>;
	upsertServerChat(entry: ChatListEntry): void;
	setSelectedChatId(chatId: string | null): void;
}

interface SlashCommandChatState {
	activeChatId: string | null;
	entries: readonly TranscriptMessage[];
	isUserScrolledUp: boolean;
	getCursor(): { transcriptViewId: string; lastOrdinal: number };
	appendLocalNotice(noticeType: LocalNoticeType, content: string): void;
	appendLocalNoticeForChat(chatId: string, noticeType: LocalNoticeType, content: string): void;
	noticeRevisionForChat(chatId: string): number;
	clearLocalNoticesForChat(chatId: string, throughRevision?: number): void;
}

export interface ConversationForkSource {
	readonly transcript: Pick<SlashCommandChatState, 'entries' | 'getCursor'>;
	readonly refetchTranscript?: () => Promise<void>;
}

interface SlashCommandComposerState {
	inputText: string;
	images: File[];
	readonly contentRevision: number;
	clearAfterSubmit(chatId: string): number;
	restoreDraftIfRevision(
		chatId: string,
		expectedRevision: number,
		text: string,
		images: readonly File[],
	): boolean;
}

interface SlashCommandAgentState {
	model: string;
}

interface SlashCommandLifecycle {
	beginTurn(chatId: string): void;
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
	} | null;
	supportsFork(agentId: SessionAgentId): boolean;
	supportsForkWhileRunning(agentId: SessionAgentId): boolean;
	supportsSteering(agentId: SessionAgentId): boolean;
}

export interface ConversationSlashCommandDeps {
	pendingSettings(chatId: string): Promise<boolean> | null;
	sessions: SlashCommandSessions;
	moveChatToBoundary: SidebarOrderController['moveChatToBoundary'];
	chatState: SlashCommandChatState;
	composerState: SlashCommandComposerState;
	agentState: SlashCommandAgentState;
	lifecycle: SlashCommandLifecycle;
	modelCatalogForExecutor(executorId: string): SlashCommandModelCatalog;
	navigation: {
		navigateToChat?(chatId: string): void;
		// Presents a fork without replacing its source chat's view.
		openForkedChat(chatId: string, sourceChatId: string): void;
	};
	refetchTranscript?: (chatId: string) => Promise<void>;
	// Asks the user whether to continue when the provider cannot materialize a native fork.
	// Without it the refusal reads as a plain failure.
	confirmHandoffFork?: () => Promise<boolean>;
	scrollToBottom(): void;
}

export type SlashCommandSubmissionResolution =
	| {
			kind: 'handled';
			outcome: ConversationSubmissionOutcome | Promise<ConversationSubmissionOutcome>;
	  }
	| { kind: 'steer'; content: string }
	| { kind: 'continue'; content: string };

export class ConversationSlashCommandService {
	readonly #forkHandoff: ConversationForkHandoffService;
	readonly #scheduleInFlight = new Set<string>();
	// Serializes each chat's complete incremental tag read-modify-write operation.
	readonly #tagMutationTails = new Map<string, Promise<void>>();

	constructor(
		private readonly deps: ConversationSlashCommandDeps,
		acceptedInputs = new AcceptedInputSubmissionService(),
	) {
		this.#forkHandoff = new ConversationForkHandoffService(
			deps, acceptedInputs, (chat, submit) => this.#submitAfterPendingSettings(chat, false, submit),
		);
	}

	#submitAfterPendingSettings(
		chat: ChatSessionRecord,
		ownsComposer: boolean,
		submit: (current: ChatSessionRecord) => Promise<ConversationSubmissionOutcome>,
	): Promise<ConversationSubmissionOutcome> {
		const pending = this.deps.pendingSettings(chat.id);
		if (!pending) return submit(chat);
		const draftRevision = this.deps.composerState.contentRevision;
		return pending.then((accepted) => {
			const current = this.deps.sessions.byId[chat.id];
			if (!accepted || !current) return 'rejected';
			if (
				current.agentOwnershipEpoch !== chat.agentOwnershipEpoch
				|| current.executorId !== chat.executorId
				|| current.agentId !== chat.agentId
			) return 'rejected';
			if (ownsComposer && (
				this.deps.sessions.selectedChatId !== chat.id
				|| this.deps.composerState.contentRevision !== draftRevision
			)) return 'no-op';
			return submit(current);
		});
	}

	dispatchSubmission(input: {
		chatId: string;
		chat: ChatSessionRecord;
		text: string;
		images: File[];
		ownsComposer: boolean;
		executionPolicy?: 'conversation' | 'literal';
		expectedSelection?: ScheduledPromptExecutionSelection;
	}): SlashCommandSubmissionResolution {
		const { chatId, chat, text, images, ownsComposer } = input;
		const policy = input.executionPolicy ?? 'conversation';
		if (policy === 'literal' && !isLiteralAppCommand(text)) return { kind: 'continue', content: text };
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
				outcome: this.submitMoveChatBoundaryCommand(chatId, chat, move, images, ownsComposer),
			};
		}

		const tag = parseTagCommand(text);
		if (tag.kind !== 'not-command') {
			return {
				kind: 'handled',
				outcome: this.submitTagCommand(chatId, chat, tag, images, ownsComposer),
			};
		}

		const schedule = parseScheduleInCommand(text, policy);
		if (schedule.kind !== 'not-command') {
			return {
				kind: 'handled',
				outcome: this.submitScheduleInCommand(chatId, chat, schedule, images, ownsComposer, input.expectedSelection),
			};
		}

		const agentId = chat.agentId as SessionAgentId;
		const modelCatalog = this.deps.modelCatalogForExecutor(effectiveExecutorId(chat.executorId));
		const steer = parseSteerCommand(text);
		if (steer.kind !== 'not-command') {
			const prompt = steer.kind === 'valid' ? steer.prompt : '';
			const rejection = steerSubmissionRejection({
				prompt,
				supportsSteering: modelCatalog.supportsSteering(agentId),
				attachmentCount: images.length,
			});
			if (rejection) {
				this.deps.chatState.appendLocalNotice('error', steerSubmissionRejectionNotice(rejection));
				return { kind: 'handled', outcome: 'rejected' };
			}
			return { kind: 'steer', content: prompt };
		}

		if (modelCatalog.supportsFork(agentId)) {
			const fork = parseForkCommand(text);
			if (fork) {
				if (policy === 'literal' && images.length > 0) {
					this.deps.chatState.appendLocalNotice('error', m.chat_notice_fork_attachments());
					return { kind: 'handled', outcome: 'rejected' };
				}
				if (
					chat.status === 'running' &&
					chat.isProcessing &&
					!modelCatalog.supportsForkWhileRunning(agentId)
				) {
					this.deps.chatState.appendLocalNotice('error', m.chat_notice_cannot_fork_processing());
					return { kind: 'handled', outcome: 'rejected' };
				}
				return {
					kind: 'handled',
					outcome: this.#submitAfterPendingSettings(chat, ownsComposer, (current) =>
						this.submitForkCommand(chatId, current, fork.message, images, ownsComposer)),
				};
			}
		}

		const handoff = parseHandoffCommand(text);
		if (handoff) {
			return {
				kind: 'handled',
				outcome: this.#submitAfterPendingSettings(chat, ownsComposer, (current) =>
					this.submitHandoffCommand(chatId, current, handoff.message, images, ownsComposer)),
			};
		}

		const compact = parseCompactCommand(text);
		if (compact) {
			return {
				kind: 'handled',
				outcome: this.#submitAfterPendingSettings(chat, ownsComposer, (current) =>
					this.submitCompactCommand(chatId, current, compact.instructions, ownsComposer)),
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
		expectedSelection?: ScheduledPromptExecutionSelection,
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
		const clearedRevision = ownsComposer ? deps.composerState.clearAfterSubmit(chatId) : null;
		try {
			const result = await scheduleChatPrompt({
				chatId,
				duration: command.duration,
				prompt: command.prompt,
				...(expectedSelection === undefined ? {} : { expectedSelection }),
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
			if (error instanceof ApiMutationOutcomeUnknownError) {
				deps.chatState.appendLocalNoticeForChat(chatId, 'error', m.chat_notice_schedule_in_unconfirmed({
					command: `/in ${command.duration} ${command.prompt}`,
				}));
				return 'unknown';
			}
			if (clearedRevision !== null) {
				deps.composerState.restoreDraftIfRevision(chatId, clearedRevision, previousText, []);
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
		const clearedContentRevision = ownsComposer
			? deps.composerState.clearAfterSubmit(chatId)
			: null;
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
		const clearedContentRevision = ownsComposer
			? deps.composerState.clearAfterSubmit(chatId)
			: null;
		const result = await deps.moveChatToBoundary(chatId, command.boundary);
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
			deps.chatState.appendLocalNotice('info', moveChatNotice(command.boundary, result.changed));
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
		const clearedContentRevision = ownsComposer
			? deps.composerState.clearAfterSubmit(chatId)
			: null;

		return this.#enqueueTagMutation(chatId, async () => {
			let mutation: ChatTagsMutationResponse;
			try {
				mutation = await deps.sessions.applyChatTagDelta({
					chatId,
					...(command.action === 'add' ? { addTags: command.tags } : { removeTags: command.tags }),
				});
			} catch (error) {
				this.#restoreComposerIfUntouched({
					chatId,
					ownsComposer,
					text: previousText,
					images: previousImages,
					clearedContentRevision,
				});
				deps.chatState.appendLocalNoticeForChat(
					chatId,
					'error',
					tagMutationFailureNotice(error, deps.sessions.tagReconciliationKind(chatId)),
				);
				return 'rejected';
			}
			const changedTags = command.action === 'add' ? mutation.addedTags : mutation.removedTags;

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
		clearedContentRevision: number | null;
	}): void {
		const { deps } = this;
		if (!input.ownsComposer || input.clearedContentRevision === null) return;
		deps.composerState.restoreDraftIfRevision(
			input.chatId,
			input.clearedContentRevision,
			input.text,
			input.images,
		);
	}

	async submitCompactCommand(
		chatId: string,
		chat: ChatSessionRecord,
		instructions: string,
		clearComposer: boolean,
	): Promise<ConversationSubmissionOutcome> {
		const { deps } = this;
		if (chat.status !== 'running') {
			deps.chatState.appendLocalNoticeForChat(chatId, 'error', m.chat_notice_cannot_compact_draft());
			return 'rejected';
		}

		const previousText = deps.composerState.inputText;
		const previousImages = [...deps.composerState.images];
		const clearedRevision = clearComposer ? deps.composerState.clearAfterSubmit(chatId) : null;

		try {
			await compactChat({
				chatId,
				clientRequestId: createClientCommandId(),
				instructions: instructions || undefined,
			});
			return 'accepted';
		} catch (error) {
			if (clearedRevision !== null) {
				deps.composerState.restoreDraftIfRevision(
					chatId,
					clearedRevision,
					previousText,
					previousImages,
				);
			}
			deps.chatState.appendLocalNoticeForChat(
				chatId,
				'error',
				m.chat_notice_failed_compact({ detail: errorDetail(error) }),
			);
			return 'rejected';
		}
	}

	submitHandoffCommand(
		...args: Parameters<ConversationForkHandoffService['submitHandoffCommand']>
	): Promise<ConversationSubmissionOutcome> {
		return this.#forkHandoff.submitHandoffCommand(...args);
	}

	submitForkCommand(
		...args: Parameters<ConversationForkHandoffService['submitForkCommand']>
	): Promise<ConversationSubmissionOutcome> {
		return this.#forkHandoff.submitForkCommand(...args);
	}

	forkChat(...args: Parameters<ConversationForkHandoffService['forkChat']>): Promise<void> {
		return this.#forkHandoff.forkChat(...args);
	}
}

function moveChatNotice(boundary: 'top' | 'bottom', changed: boolean): string {
	if (boundary === 'top') {
		return changed ? m.chat_notice_move_top_success() : m.chat_notice_move_top_unchanged();
	}
	return changed ? m.chat_notice_move_bottom_success() : m.chat_notice_move_bottom_unchanged();
}

function tagMutationFailureNotice(error: unknown, kind: ChatTagReconciliationKind): string {
	if (error instanceof ChatTagMutationBlockedError) return m.chat_tags_mutation_blocked();
	switch (kind) {
		case 'durability':
			return m.chat_tags_confirmation_unknown();
		case 'committed-refresh':
			return m.chat_tags_refresh_required();
		case 'conflict-refresh':
			return m.chat_tags_conflict_refresh_required();
		case null:
			return m.notifications_update_chat_tags_failed();
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
