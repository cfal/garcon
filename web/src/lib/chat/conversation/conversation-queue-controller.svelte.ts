import {
	deleteQueuedInput,
	getChatExecutionControl,
	pauseChatQueue,
	replaceQueuedInput,
	resumeChatQueue,
} from '$lib/api/chats.js';
import { ApiError } from '$lib/api/client.js';
import {
	parseChatExecutionControlState,
	type ChatExecutionControlState,
} from '$shared/chat-execution-control';
import type { QueueCommandErrorResponse } from '$shared/chat-command-contracts';
import { createClientCommandId } from './client-command-id.js';
import type { AcceptedInputSubmissionService } from './accepted-input-submission-service.js';
import type { SessionControllerDeps } from './conversation-session-controller.svelte.js';
import { errorDetail } from './conversation-submission-helpers.js';
import * as m from '$lib/paraglide/messages.js';

interface FailedQueueSubmission {
	sequence: number;
	text: string;
	images: File[];
}

export interface ConversationQueueControllerOptions {
	get sessions(): Pick<SessionControllerDeps['sessions'], 'selectedChatId'>;
	get chatState(): Pick<SessionControllerDeps['chatState'], 'clearLocalNotices' | 'appendLocalNotice'>;
	get composerState(): Pick<
		SessionControllerDeps['composerState'],
		'inputText' | 'images' | 'saveDraft'
	>;
	get lifecycle(): Pick<SessionControllerDeps['lifecycle'], 'currentChatId'>;
	get conversationUi(): Pick<
		SessionControllerDeps['conversationUi'],
		'setExecutionControl' | 'setExecutionControlFromRefresh'
	>;
	get acceptedInputs(): Pick<AcceptedInputSubmissionService, 'enqueue'>;
}

export class ConversationQueueController {
	#controlRefreshByChatId = new Map<string, Promise<void>>();
	#submissionSequence = 0;
	#pendingSubmissionsByChatId = new Map<string, number>();
	#failedSubmissionsByChatId = new Map<string, FailedQueueSubmission[]>();

	constructor(private readonly options: ConversationQueueControllerOptions) {}

	pendingControlRefresh(chatId: string): Promise<void> | undefined {
		return this.#controlRefreshByChatId.get(chatId);
	}

	beginSubmission(chatId: string): number {
		const pendingCount = this.#pendingSubmissionsByChatId.get(chatId) ?? 0;
		if (pendingCount === 0) this.options.chatState.clearLocalNotices();
		this.#pendingSubmissionsByChatId.set(chatId, pendingCount + 1);
		return ++this.#submissionSequence;
	}

	recordSubmissionFailure(chatId: string, failure: FailedQueueSubmission): void {
		const failures = this.#failedSubmissionsByChatId.get(chatId) ?? [];
		this.#failedSubmissionsByChatId.set(chatId, [...failures, failure]);
	}

	finishSubmission(chatId: string): void {
		const remaining = (this.#pendingSubmissionsByChatId.get(chatId) ?? 1) - 1;
		if (remaining > 0) {
			this.#pendingSubmissionsByChatId.set(chatId, remaining);
			return;
		}

		this.#pendingSubmissionsByChatId.delete(chatId);
		const failures = this.#failedSubmissionsByChatId.get(chatId) ?? [];
		this.#failedSubmissionsByChatId.delete(chatId);
		if (failures.length === 0 || this.options.sessions.selectedChatId !== chatId) return;

		const composerUntouched =
			this.options.composerState.inputText.length === 0 && this.options.composerState.images.length === 0;
		if (!composerUntouched) return;

		const earliestFailure = failures.reduce((earliest, failure) =>
			failure.sequence < earliest.sequence ? failure : earliest,
		);
		this.options.composerState.inputText = earliestFailure.text;
		this.options.composerState.images = earliestFailure.images;
		this.options.composerState.saveDraft(chatId);
	}

	startControlRefresh(chatId: string): Promise<void> {
		const refresh = getChatExecutionControl(chatId).then((result) => {
			this.options.conversationUi.setExecutionControlFromRefresh(chatId, result.control);
		});
		this.#controlRefreshByChatId.set(chatId, refresh);
		void refresh
			.catch(() => {
				// A later broadcast, reconnect, or server-side admission check still preserves FIFO.
			})
			.finally(() => {
				if (this.#controlRefreshByChatId.get(chatId) === refresh) {
					this.#controlRefreshByChatId.delete(chatId);
				}
			});
		return refresh;
	}

	async settleControlRefresh(refresh: Promise<void>): Promise<void> {
		try {
			await refresh;
		} catch {
			// The server rejects a direct run while queued inputs are pending.
		}
	}

	handlePause(): Promise<void> {
		const chatId = this.options.sessions.selectedChatId || this.options.lifecycle.currentChatId;
		if (!chatId) return Promise.resolve();
		return this.pauseForChat(chatId);
	}

	handleResume(pauseId: string): Promise<void> {
		const chatId = this.options.sessions.selectedChatId || this.options.lifecycle.currentChatId;
		if (!chatId) return Promise.resolve();
		return this.resumeForChat(chatId, pauseId);
	}

	handleControlError(action: 'pause' | 'resume', error: unknown): void {
		this.options.chatState.appendLocalNotice(
			'error',
			action === 'pause'
				? m.chat_notice_failed_pause_queue({ detail: errorDetail(error) })
				: m.chat_notice_failed_resume_queue({ detail: errorDetail(error) }),
		);
	}

	async pauseForChat(chatId: string): Promise<void> {
		const result = await pauseChatQueue(chatId);
		this.options.conversationUi.setExecutionControl(chatId, result.control);
	}

	async resumeForChat(chatId: string, pauseId: string): Promise<void> {
		try {
			const result = await resumeChatQueue(chatId, pauseId);
			this.options.conversationUi.setExecutionControl(chatId, result.control);
		} catch (error) {
			this.#applyMutationErrorControl(chatId, error);
			throw error;
		}
	}

	async createForChat(chatId: string, content: string): Promise<void> {
		const submission = this.options.acceptedInputs.enqueue({ chatId, content });
		try {
			const result = await submission.submit();
			this.options.conversationUi.setExecutionControl(chatId, result.control);
		} catch (error) {
			this.#applyMutationErrorControl(chatId, error);
			throw error;
		}
	}

	async replaceForChat(
		chatId: string,
		entryId: string,
		content: string,
		expectedRevision: number,
	): Promise<void> {
		try {
			const result = await replaceQueuedInput({
				clientRequestId: createClientCommandId(),
				chatId,
				entryId,
				content,
				expectedRevision,
			});
			this.options.conversationUi.setExecutionControl(chatId, result.control);
		} catch (error) {
			this.#applyMutationErrorControl(chatId, error);
			throw error;
		}
	}

	async deleteForChat(chatId: string, entryId: string): Promise<void> {
		try {
			const result = await deleteQueuedInput({
				clientRequestId: createClientCommandId(),
				chatId,
				entryId,
			});
			this.options.conversationUi.setExecutionControl(chatId, result.control);
		} catch (error) {
			this.#applyMutationErrorControl(chatId, error);
			throw error;
		}
	}

	async handleDelete(entryId: string): Promise<void> {
		const chatId = this.options.sessions.selectedChatId || this.options.lifecycle.currentChatId;
		if (!chatId) return;
		try {
			await this.deleteForChat(chatId, entryId);
		} catch (error) {
			if (isDepartedQueueEntryError(error)) return;
			this.options.chatState.appendLocalNotice(
				'error',
				m.chat_notice_failed_remove_queued_message({ detail: errorDetail(error) }),
			);
		}
	}

	#applyMutationErrorControl(chatId: string, error: unknown): void {
		const control = controlFromMutationError(error);
		if (control) this.options.conversationUi.setExecutionControl(chatId, control);
	}
}

function controlFromMutationError(error: unknown): ChatExecutionControlState | null {
	if (!(error instanceof ApiError) || !isQueueCommandErrorResponse(error.payload)) return null;
	return error.payload.control ? parseChatExecutionControlState(error.payload.control) : null;
}

function isQueueCommandErrorResponse(value: unknown): value is QueueCommandErrorResponse {
	if (!value || typeof value !== 'object') return false;
	const body = value as Record<string, unknown>;
	return (
		body.success === false &&
		typeof body.error === 'string' &&
		typeof body.errorCode === 'string' &&
		typeof body.retryable === 'boolean'
	);
}

function isDepartedQueueEntryError(error: unknown): boolean {
	return (
		error instanceof ApiError &&
		(error.errorCode === 'QUEUE_ENTRY_ALREADY_SENT' || error.errorCode === 'QUEUE_ENTRY_NOT_FOUND')
	);
}
