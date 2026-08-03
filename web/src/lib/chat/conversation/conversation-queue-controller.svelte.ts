import {
	deleteQueuedInput,
	getChatExecutionControl,
	moveQueuedInput,
	pauseChatQueue,
	replaceQueuedInput,
	resumeChatQueue,
} from '$lib/api/chats.js';
import { ApiError } from '$lib/api/client.js';
import {
	parseChatExecutionControlState,
	parseExecutionControlServerInstanceId,
	type ChatExecutionControlState,
} from '$shared/chat-execution-control';
import type {
	QueueCommandErrorResponse,
	QueueEntryMoveCommandRequest,
	QueueEntryPlacement,
} from '$shared/chat-command-contracts';
import type { QueueEntry } from '$shared/queue-state';
import { createClientCommandId } from './client-command-id.js';
import type { AcceptedInputSubmissionService } from './accepted-input-submission-service.js';
import type { SessionControllerDeps } from './conversation-session-controller.svelte.js';
import { errorDetail } from './conversation-submission-helpers.js';
import { steerFailureNotice } from './steer-failure-notice.js';
import * as m from '$lib/paraglide/messages.js';
import {
	CommandOutcomeUnknownError,
	submitIdempotentCommand,
} from './idempotent-command.js';

interface FailedQueueSubmission {
	sequence: number;
	text: string;
	images: File[];
}

export interface ConversationQueueControllerOptions {
	get sessions(): Pick<SessionControllerDeps['sessions'], 'selectedChatId'>;
	get chatState(): Pick<
		SessionControllerDeps['chatState'],
		'clearLocalNotices' | 'appendLocalNotice' | 'loadMessages'
	>;
	get composerState(): Pick<
		SessionControllerDeps['composerState'],
		'inputText' | 'images' | 'saveDraft'
	>;
	get lifecycle(): Pick<SessionControllerDeps['lifecycle'], 'currentChatId'>;
	get conversationUi(): Pick<
		SessionControllerDeps['conversationUi'],
		| 'setExecutionControlFromLiveUpdate'
		| 'setExecutionControlFromRefresh'
		| 'isExecutionControlSocketInstanceConfirmed'
	>;
	get acceptedInputs(): Pick<AcceptedInputSubmissionService, 'enqueue' | 'steerQueuedEntry'>;
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
		const refresh = getChatExecutionControl(chatId)
			.then((result) => {
				this.options.conversationUi.setExecutionControlFromRefresh(chatId, result.control);
			})
			.finally(() => {
				if (this.#controlRefreshByChatId.get(chatId) === refresh) {
					this.#controlRefreshByChatId.delete(chatId);
				}
			});
		this.#controlRefreshByChatId.set(chatId, refresh);
		void refresh.catch(() => {
			// A later broadcast, reconnect, or server-side admission check still preserves FIFO.
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
		this.options.conversationUi.setExecutionControlFromLiveUpdate(chatId, result.control);
	}

	async resumeForChat(chatId: string, pauseId: string): Promise<void> {
		try {
			const result = await resumeChatQueue(chatId, pauseId);
			this.options.conversationUi.setExecutionControlFromLiveUpdate(chatId, result.control);
		} catch (error) {
			this.#applyMutationErrorControl(chatId, error);
			throw error;
		}
	}

	async createForChat(chatId: string, content: string): Promise<void> {
		const submission = this.options.acceptedInputs.enqueue({ chatId, content });
		try {
			const result = await submission.submit();
			this.options.conversationUi.setExecutionControlFromLiveUpdate(chatId, result.control);
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
			this.options.conversationUi.setExecutionControlFromLiveUpdate(chatId, result.control);
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
			this.options.conversationUi.setExecutionControlFromLiveUpdate(chatId, result.control);
		} catch (error) {
			this.#applyMutationErrorControl(chatId, error);
			throw error;
		}
	}

	async moveForChat(
		chatId: string,
		source: QueueEntry,
		target: QueueEntry,
		placement: QueueEntryPlacement,
		reorderRevision: number,
	): Promise<void> {
		const request: QueueEntryMoveCommandRequest = {
			clientRequestId: createClientCommandId(),
			chatId,
			entryId: source.id,
			targetEntryId: target.id,
			placement,
			expectedReorderRevision: reorderRevision,
			expectedSourceRevision: source.revision,
			expectedTargetRevision: target.revision,
		};
		try {
			const result = await submitIdempotentCommand(() => moveQueuedInput(request));
			this.options.conversationUi.setExecutionControlFromLiveUpdate(chatId, result.control);
		} catch (error) {
			this.#applyMutationErrorControl(chatId, error);
			if (error instanceof CommandOutcomeUnknownError) {
				await this.settleControlRefresh(this.startControlRefresh(chatId));
			}
			throw error;
		}
	}

	async steerHeadForChat(
		chatId: string,
		entry: QueueEntry,
		expectedReorderRevision: number,
	): Promise<void> {
		this.options.chatState.clearLocalNotices();
		const submission = this.options.acceptedInputs.steerQueuedEntry({
			chatId,
			entryId: entry.id,
			expectedRevision: entry.revision,
			expectedReorderRevision,
		});

		try {
			const result = await submission.submit();
			if (result.control) {
				this.options.conversationUi.setExecutionControlFromLiveUpdate(chatId, result.control);
			}
			const instanceConfirmed = this.options.conversationUi
				.isExecutionControlSocketInstanceConfirmed(result.serverInstanceId);
			if (!instanceConfirmed) {
				await this.#reconcileSelectedSteerTranscript(chatId);
				this.#appendUnconfirmedSteerNotice(chatId);
			}
		} catch (error) {
			const failure = queueEntrySteerFailure(error);
			if (failure.control) {
				this.options.conversationUi.setExecutionControlFromRefresh(chatId, failure.control);
			} else {
				await this.settleControlRefresh(this.startControlRefresh(chatId));
			}
			const instanceConfirmed = failure.serverInstanceId !== null
				&& this.options.conversationUi.isExecutionControlSocketInstanceConfirmed(
					failure.serverInstanceId,
				);
			if (!instanceConfirmed) await this.#reconcileSelectedSteerTranscript(chatId);
			if (this.options.sessions.selectedChatId === chatId) {
				this.options.chatState.appendLocalNotice(
					'error',
					!instanceConfirmed || failure.deliveryOutcome === 'unknown' || !failure.structured
						? m.chat_notice_steer_outcome_unconfirmed()
						: steerFailureNotice(error),
				);
			}
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

	async #reconcileSelectedSteerTranscript(chatId: string): Promise<void> {
		if (this.options.sessions.selectedChatId !== chatId) return;
		try {
			await this.options.chatState.loadMessages(chatId);
		} catch {
			// A later WebSocket reconnect or chat activation retries the authoritative snapshot.
		}
	}

	#appendUnconfirmedSteerNotice(chatId: string): void {
		if (this.options.sessions.selectedChatId !== chatId) return;
		this.options.chatState.appendLocalNotice('error', m.chat_notice_steer_outcome_unconfirmed());
	}

	#applyMutationErrorControl(chatId: string, error: unknown): void {
		const control = controlFromMutationError(error);
		if (control) this.options.conversationUi.setExecutionControlFromRefresh(chatId, control);
	}

}

interface QueueEntrySteerFailure {
	structured: boolean;
	deliveryOutcome: 'not-sent' | 'unknown' | 'accepted';
	serverInstanceId: string | null;
	control: ChatExecutionControlState | null;
}

function queueEntrySteerFailure(error: unknown): QueueEntrySteerFailure {
	const failure = error instanceof CommandOutcomeUnknownError ? error.cause : error;
	if (!(failure instanceof ApiError)) {
		return {
			structured: false,
			deliveryOutcome: 'unknown',
			serverInstanceId: null,
			control: null,
		};
	}
	const response = parseQueueEntrySteerErrorResponse(failure.payload);
	if (!response) {
		return {
			structured: false,
			deliveryOutcome: 'unknown',
			serverInstanceId: null,
			control: null,
		};
	}
	return {
		structured: true,
		deliveryOutcome: response.deliveryOutcome,
		serverInstanceId: response.serverInstanceId,
		control: response.control,
	};
}

interface ParsedQueueEntrySteerErrorResponse {
	deliveryOutcome: 'not-sent' | 'unknown' | 'accepted';
	serverInstanceId: string;
	control: ChatExecutionControlState | null;
}

function parseQueueEntrySteerErrorResponse(
	value: unknown,
): ParsedQueueEntrySteerErrorResponse | null {
	if (!isQueueCommandErrorResponse(value)) return null;
	const deliveryOutcome = Reflect.get(value, 'deliveryOutcome');
	if (
		deliveryOutcome !== 'not-sent' &&
		deliveryOutcome !== 'unknown' &&
		deliveryOutcome !== 'accepted'
	) return null;
	const serverInstanceId = parseExecutionControlServerInstanceId(
		Reflect.get(value, 'serverInstanceId'),
	);
	if (!serverInstanceId) return null;
	const rawControl = Reflect.get(value, 'control');
	const control = rawControl === undefined ? null : parseChatExecutionControlState(rawControl);
	if (rawControl !== undefined && !control) return null;
	if (control && control.serverInstanceId !== serverInstanceId) return null;
	return {
		deliveryOutcome,
		serverInstanceId,
		control,
	};
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
