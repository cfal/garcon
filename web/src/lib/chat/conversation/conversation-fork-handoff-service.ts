import { ApiError } from '$lib/api/client.js';
import type { ChatImage } from '$shared/chat-types';
import type { ChatListEntry } from '$shared/chat-list';
import { effectiveExecutorId } from '$shared/executors';
import { createClientChatId } from '$shared/client-chat-id';
import type { ChatSessionRecord } from '$lib/chat/sessions/chat-session-types';
import * as m from '$lib/paraglide/messages.js';
import { CommandOutcomeUnknownError } from './idempotent-command.js';
import { resolveConversationModelSelection } from './conversation-model-selection.js';
import { errorDetail, prepareChatImages } from './conversation-submission-helpers.js';
import type { AcceptedInputSubmissionService, PreparedForkInput } from './accepted-input-submission-service.js';
import type { ConversationSubmissionOutcome } from './conversation-submission-outcome.js';
import type { ConversationForkSource, ConversationSlashCommandDeps } from './conversation-slash-command-service.js';
import {
	remapForkAtMessage,
	selectForkAtMessage,
	type ForkAtMessageSelection,
} from '$lib/chat/actions/fork-at-message-action.js';
import {
	forkFailureNotice,
	isHandoffForkConfirmationError,
	requestChatFork,
} from '$lib/chat/actions/fork-chat-request.js';
import type { ForkChatResponse } from '$shared/chat-command-contracts';

type ForkHandoffDeps = Pick<ConversationSlashCommandDeps,
	'sessions' | 'chatState' | 'composerState' | 'agentState' | 'lifecycle' | 'modelCatalogForExecutor'
	| 'navigation' | 'refetchTranscript' | 'confirmHandoffFork'>;

export class ConversationForkHandoffService {
	constructor(
		private readonly deps: ForkHandoffDeps,
		private readonly acceptedInputs: AcceptedInputSubmissionService,
		private readonly submitAfterPendingSettings: (
			chat: ChatSessionRecord,
			submit: () => Promise<ConversationSubmissionOutcome>,
		) => Promise<ConversationSubmissionOutcome>,
	) {}

	// Continues the chat under the same agent in a fresh chat, then navigates
	// there so the user lands in the continuation rather than the chat they left.
	async submitHandoffCommand(
		sourceChatId: string,
		sourceChat: ChatSessionRecord,
		message: string,
		images: File[],
		clearComposer: boolean,
	): Promise<ConversationSubmissionOutcome> {
		const { deps } = this;
		if (sourceChat.status !== 'running') {
			deps.chatState.appendLocalNoticeForChat(sourceChatId, 'error', m.chat_notice_cannot_handoff_draft());
			return 'rejected';
		}
		if (!message.trim()) {
			deps.chatState.appendLocalNoticeForChat(sourceChatId, 'error', m.chat_notice_handoff_requires_message());
			return 'rejected';
		}

		const previousText = deps.composerState.inputText;
		const previousImages = [...deps.composerState.images];
		deps.chatState.appendLocalNoticeForChat(sourceChatId, 'progress', m.chat_notice_handing_off_chat());
		// Clearing through this revision on settle removes the progress notice while
		// keeping any error notice the failure paths append after it.
		const progressNoticeRevision = deps.chatState.noticeRevisionForChat(sourceChatId);
		deps.chatState.isUserScrolledUp = false;
		const clearedRevision = clearComposer
			? deps.composerState.clearAfterSubmit(sourceChatId)
			: null;

		try {
			let imagePayload: ChatImage[] = [];
			if (images.length > 0) {
				try {
					imagePayload = await prepareChatImages(images);
				} catch (error) {
					this.#restoreComposer(sourceChatId, previousText, previousImages, clearedRevision);
					deps.chatState.appendLocalNoticeForChat(
						sourceChatId,
						'error',
						m.chat_notice_failed_prepare_attachments({ detail: errorDetail(error) }),
					);
					return 'rejected';
				}
			}

			const submission = this.acceptedInputs.selfHandoff({
				sourceChatId,
				chatId: createClientChatId(),
				command: message.trim(),
				...(imagePayload.length > 0 ? { images: imagePayload } : {}),
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
				// An ambiguous transport outcome may have already created the target and
				// started its turn. Restoring the composer and calling it a failure
				// invites a resubmission that would produce a second continuation.
				const outcomeUnknown = error instanceof CommandOutcomeUnknownError;
				if (!outcomeUnknown) {
					this.#restoreComposer(sourceChatId, previousText, previousImages, clearedRevision);
				}
				deps.chatState.appendLocalNoticeForChat(
					sourceChatId,
					'error',
					outcomeUnknown
						? m.chat_notice_handoff_outcome_unconfirmed()
						: m.chat_notice_failed_handoff({ detail: errorDetail(error) }),
				);
				return outcomeUnknown ? 'unknown' : 'rejected';
			}
		} finally {
			deps.chatState.clearLocalNoticesForChat(sourceChatId, progressNoticeRevision);
		}
	}

	async #submitForkRunWithConfirmation(
		submission: PreparedForkInput,
	): Promise<Awaited<ReturnType<PreparedForkInput['submit']>> | null> {
		try {
			return await submission.submit();
		} catch (error) {
			if (!isHandoffForkConfirmationError(error) || !this.deps.confirmHandoffFork) throw error;
			if (!(await this.deps.confirmHandoffFork())) return null;
			return submission.submitWithHandoffFork();
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
			deps.chatState.appendLocalNoticeForChat(sourceChatId, 'error', m.chat_notice_cannot_fork_draft());
			return 'rejected';
		}

		const model = sourceChat.model ?? deps.agentState.model;
		const previousText = deps.composerState.inputText;
		const previousImages = [...deps.composerState.images];
		deps.chatState.appendLocalNoticeForChat(sourceChatId, 'progress', m.chat_notice_forking_chat());
		// Clearing through this revision on settle removes the progress notice while
		// keeping any error notice the failure paths append after it.
		const progressNoticeRevision = deps.chatState.noticeRevisionForChat(sourceChatId);
		deps.chatState.isUserScrolledUp = false;
		const clearedRevision = clearComposer
			? deps.composerState.clearAfterSubmit(sourceChatId)
			: null;

		try {
			if (!message.trim()) {
				return await this.#submitForkOnlyCommand(
					sourceChatId,
					previousText,
					previousImages,
					clearedRevision,
				);
			}

			let imagePayload: ChatImage[] = [];
			if (images.length > 0) {
				try {
					imagePayload = await prepareChatImages(images);
				} catch (error) {
					this.#restoreComposer(sourceChatId, previousText, previousImages, clearedRevision);
					deps.chatState.appendLocalNoticeForChat(
						sourceChatId,
						'error',
						m.chat_notice_failed_prepare_attachments({ detail: errorDetail(error) }),
					);
					return 'rejected';
				}
			}

			const forkChatId = createClientChatId();
			const selection = resolveConversationModelSelection(
				{
					agentId: sourceChat.agentId,
					model,
					apiProviderId: sourceChat.apiProviderId ?? null,
					modelEndpointId: sourceChat.modelEndpointId ?? null,
					modelProtocol: sourceChat.modelProtocol ?? null,
				},
				deps.modelCatalogForExecutor(effectiveExecutorId(sourceChat.executorId)),
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
				const response = await this.#submitForkRunWithConfirmation(submission);
				if (!response) {
					this.#restoreComposer(sourceChatId, previousText, previousImages, clearedRevision);
					return 'rejected';
				}
				deps.sessions.upsertServerChat(response.chat);
				deps.navigation.openForkedChat(response.chat.id, sourceChatId);
				if (response.status === 'accepted') {
					deps.lifecycle.beginTurn(response.chat.id);
				}
				return 'accepted';
			} catch (error) {
				const outcomeUnknown = error instanceof CommandOutcomeUnknownError;
				if (!outcomeUnknown) {
					this.#restoreComposer(sourceChatId, previousText, previousImages, clearedRevision);
				}
				deps.chatState.appendLocalNoticeForChat(
					sourceChatId,
					'error',
					outcomeUnknown
						? m.chat_notice_fork_outcome_unconfirmed()
						: m.chat_notice_failed_fork_chat({ detail: errorDetail(error) }),
				);
				return outcomeUnknown ? 'unknown' : 'rejected';
			}
		} finally {
			deps.chatState.clearLocalNoticesForChat(sourceChatId, progressNoticeRevision);
		}
	}

	async forkChat(
		sourceChatId: string,
		upToOrdinal?: number,
		source?: ConversationForkSource,
	): Promise<void> {
		const sourceChat = this.deps.sessions.byId[sourceChatId];
		if (!sourceChat || sourceChat.status === 'draft') {
			this.deps.chatState.appendLocalNoticeForChat(
				sourceChatId,
				'error',
				m.chat_notice_cannot_fork_draft(),
			);
			return;
		}
		this.deps.chatState.appendLocalNoticeForChat(
			sourceChatId,
			'progress',
			m.chat_notice_forking_chat(),
		);
		const progressNoticeRevision = this.deps.chatState.noticeRevisionForChat(sourceChatId);
		try {
			await this.submitAfterPendingSettings(sourceChat, async () => {
				await this.#performForkOnly(sourceChatId, upToOrdinal, source);
				return 'accepted';
			});
		} catch (error) {
			this.deps.chatState.appendLocalNoticeForChat(sourceChatId, 'error', forkFailureNotice(error));
		} finally {
			this.deps.chatState.clearLocalNoticesForChat(sourceChatId, progressNoticeRevision);
		}
	}

	// Resolves null when the user declines a handoff fork, so callers stay silent instead of
	// reporting a failure.
	async #performForkOnly(
		sourceChatId: string,
		upToOrdinal?: number,
		source?: ConversationForkSource,
	): Promise<ChatListEntry | null> {
		const sourceTranscript = source?.transcript ?? this.deps.chatState;
		const chatId = createClientChatId();
		const selection =
			upToOrdinal === undefined
				? null
				: selectForkAtMessage(
						sourceTranscript.entries,
						sourceTranscript.getCursor().transcriptViewId,
						upToOrdinal,
					);
		if (upToOrdinal !== undefined && !selection) {
			throw new Error(m.chat_notice_fork_message_no_longer_available());
		}
		let result: ForkChatResponse | null;
		try {
			result = await requestChatFork(
				{ sourceChatId, chatId, ...(selection ? forkPointParams(selection) : {}) },
				this.deps.confirmHandoffFork,
			);
		} catch (error) {
			const defaultRefetch = this.deps.refetchTranscript;
			const refetchTranscript =
				source?.refetchTranscript ?? (defaultRefetch ? () => defaultRefetch(sourceChatId) : null);
			if (!selection || !isStaleForkPointError(error) || !refetchTranscript) {
				throw error;
			}
			try {
				await refetchTranscript();
			} catch {
				throw error;
			}
			const remapped = remapForkAtMessage(
				sourceTranscript.entries,
				sourceTranscript.getCursor().transcriptViewId,
				selection,
			);
			if (!remapped) throw error;
			result = await requestChatFork(
				{ sourceChatId, chatId, ...forkPointParams(remapped) },
				this.deps.confirmHandoffFork,
			);
		}
		if (!result) return null;
		this.deps.sessions.upsertServerChat(result.chat);
		this.deps.navigation.openForkedChat(result.chat.id, sourceChatId);
		return result.chat;
	}

	async #submitForkOnlyCommand(
		sourceChatId: string,
		previousText: string,
		previousImages: File[],
		clearedRevision: number | null,
	): Promise<ConversationSubmissionOutcome> {
		try {
			if (!(await this.#performForkOnly(sourceChatId))) {
				this.#restoreComposer(sourceChatId, previousText, previousImages, clearedRevision);
				return 'rejected';
			}
			return 'accepted';
		} catch (error) {
			// An unconfirmed fork may already exist; restoring the command would invite a second one.
			const outcomeUnknown = error instanceof CommandOutcomeUnknownError;
			if (!outcomeUnknown) {
				this.#restoreComposer(sourceChatId, previousText, previousImages, clearedRevision);
			}
			this.deps.chatState.appendLocalNoticeForChat(sourceChatId, 'error', forkFailureNotice(error));
			return outcomeUnknown ? 'unknown' : 'rejected';
		}
	}

	#restoreComposer(
		chatId: string,
		previousText: string,
		previousImages: File[],
		clearedRevision: number | null,
	): void {
		if (clearedRevision === null) return;
		this.deps.composerState.restoreDraftIfRevision(
			chatId,
			clearedRevision,
			previousText,
			previousImages,
		);
	}
}

function forkPointParams(selection: ForkAtMessageSelection): {
	upToOrdinal: number;
	transcriptViewId: string;
} {
	return {
		upToOrdinal: selection.ordinal,
		transcriptViewId: selection.transcriptViewId,
	};
}

function isStaleForkPointError(error: unknown): error is ApiError {
	return error instanceof ApiError && error.errorCode === 'STALE_TRANSCRIPT_VIEW';
}
