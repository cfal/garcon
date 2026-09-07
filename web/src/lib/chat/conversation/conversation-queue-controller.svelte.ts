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
import { CommandOutcomeUnknownError, submitIdempotentCommand } from './idempotent-command.js';

interface FailedQueueSubmission {
	sequence: number;
	text: string;
	images: File[];
}

export interface ConversationQueueControllerOptions {
	get sessions(): Pick<SessionControllerDeps['sessions'], 'byId'>;
	get chatState(): Pick<
		SessionControllerDeps['chatState'],
		'loadMessages' | 'clearLocalNoticesForChat' | 'appendLocalNoticeForChat' | 'getCursorForChat'
	>;
	get composerState(): Pick<
		SessionControllerDeps['composerState'],
		'draftRevision' | 'isDraftEmpty' | 'restoreDraftIfRevision'
	>;
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
	#latestClearRevisionByChatId = new Map<string, number>();

	constructor(private readonly options: ConversationQueueControllerOptions) {}

	pendingControlRefresh(chatId: string): Promise<void> | undefined {
		return this.#controlRefreshByChatId.get(chatId);
	}

	beginSubmission(chatId: string): number {
		const pendingCount = this.#pendingSubmissionsByChatId.get(chatId) ?? 0;
		if (pendingCount === 0) this.options.chatState.clearLocalNoticesForChat(chatId);
		this.#pendingSubmissionsByChatId.set(chatId, pendingCount + 1);
		return ++this.#submissionSequence;
	}

	recordSubmissionFailure(chatId: string, failure: FailedQueueSubmission): void {
		const failures = this.#failedSubmissionsByChatId.get(chatId) ?? [];
		this.#failedSubmissionsByChatId.set(chatId, [...failures, failure]);
	}

	recordComposerClear(chatId: string, revision: number): void {
		this.#latestClearRevisionByChatId.set(chatId, revision);
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
		const clearedRevision = this.#latestClearRevisionByChatId.get(chatId);
		this.#latestClearRevisionByChatId.delete(chatId);
		if (
			failures.length === 0 ||
			clearedRevision === undefined ||
			!this.options.composerState.isDraftEmpty(chatId) ||
			this.options.composerState.draftRevision(chatId) !== clearedRevision
		)
			return;

		const earliestFailure = failures.reduce((earliest, failure) =>
			failure.sequence < earliest.sequence ? failure : earliest,
		);
		this.options.composerState.restoreDraftIfRevision(
			chatId,
			clearedRevision,
			earliestFailure.text,
			earliestFailure.images,
		);
	}

	startControlRefresh(chatId: string): Promise<void> {
		if (!this.#hasChat(chatId)) return Promise.resolve();
		const refresh = getChatExecutionControl(chatId)
			.then((result) => {
				if (!this.#hasChat(chatId)) return;
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

	handleControlErrorForChat(chatId: string, action: 'pause' | 'resume', error: unknown): void {
		if (!this.#hasChat(chatId)) return;
		this.options.chatState.appendLocalNoticeForChat(
			chatId,
			'error',
			action === 'pause'
				? m.chat_notice_failed_pause_queue({ detail: errorDetail(error) })
				: m.chat_notice_failed_resume_queue({ detail: errorDetail(error) }),
		);
	}

	async pauseForChat(chatId: string): Promise<void> {
		if (!this.#hasChat(chatId)) return;
		const result = await pauseChatQueue(chatId);
		if (!this.#hasChat(chatId)) return;
		this.options.conversationUi.setExecutionControlFromLiveUpdate(chatId, result.control);
	}

	async resumeForChat(chatId: string, pauseId: string): Promise<void> {
		if (!this.#hasChat(chatId)) return;
		try {
			const result = await resumeChatQueue(chatId, pauseId);
			if (!this.#hasChat(chatId)) return;
			this.options.conversationUi.setExecutionControlFromLiveUpdate(chatId, result.control);
		} catch (error) {
			this.#applyMutationErrorControl(chatId, error);
			throw error;
		}
	}

	async createForChat(chatId: string, content: string): Promise<void> {
		if (!this.#hasChat(chatId)) return;
		const submission = this.options.acceptedInputs.enqueue({
			chatId,
			transcriptViewId: this.#transcriptViewId(chatId),
			content,
		});
		try {
			const result = await submission.submit();
			if (!this.#hasChat(chatId)) return;
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
		if (!this.#hasChat(chatId)) return;
		try {
			const result = await replaceQueuedInput({
				clientRequestId: createClientCommandId(),
				chatId,
				entryId,
				content,
				expectedRevision,
			});
			if (!this.#hasChat(chatId)) return;
			this.options.conversationUi.setExecutionControlFromLiveUpdate(chatId, result.control);
		} catch (error) {
			this.#applyMutationErrorControl(chatId, error);
			throw error;
		}
	}

	async deleteForChat(chatId: string, entryId: string): Promise<void> {
		if (!this.#hasChat(chatId)) return;
		try {
			const result = await deleteQueuedInput({
				clientRequestId: createClientCommandId(),
				chatId,
				entryId,
			});
			if (!this.#hasChat(chatId)) return;
			this.options.conversationUi.setExecutionControlFromLiveUpdate(chatId, result.control);
		} catch (error) {
			this.#applyMutationErrorControl(chatId, error);
			throw error;
		}
	}

	async deleteFromPanelForChat(chatId: string, entryId: string): Promise<void> {
		try {
			await this.deleteForChat(chatId, entryId);
		} catch (error) {
			if (isDepartedQueueEntryError(error) || !this.#hasChat(chatId)) return;
			this.options.chatState.appendLocalNoticeForChat(
				chatId,
				'error',
				m.chat_notice_failed_remove_queued_message({ detail: errorDetail(error) }),
			);
		}
	}

	async moveForChat(
		chatId: string,
		source: QueueEntry,
		target: QueueEntry,
		placement: QueueEntryPlacement,
		reorderRevision: number,
	): Promise<void> {
		if (!this.#hasChat(chatId)) return;
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
			if (!this.#hasChat(chatId)) return;
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
		if (!this.#hasChat(chatId)) return;
		this.options.chatState.clearLocalNoticesForChat(chatId);
		const submission = this.options.acceptedInputs.steerQueuedEntry({
			chatId,
			transcriptViewId: this.#transcriptViewId(chatId),
			entryId: entry.id,
			expectedRevision: entry.revision,
			expectedReorderRevision,
		});

		try {
			const result = await submission.submit();
			if (!this.#hasChat(chatId)) return;
			if (result.control) {
				this.options.conversationUi.setExecutionControlFromLiveUpdate(chatId, result.control);
			}
			const instanceConfirmed =
				this.options.conversationUi.isExecutionControlSocketInstanceConfirmed(
					result.serverInstanceId,
				);
			if (!instanceConfirmed) {
				await this.#reconcileSteerTranscript(chatId);
				this.#appendUnconfirmedSteerNotice(chatId);
			}
		} catch (error) {
			if (!this.#hasChat(chatId)) throw error;
			const failure = queueEntrySteerFailure(error);
			if (failure.control) {
				this.options.conversationUi.setExecutionControlFromRefresh(chatId, failure.control);
			} else {
				await this.settleControlRefresh(this.startControlRefresh(chatId));
			}
			const instanceConfirmed =
				failure.serverInstanceId !== null &&
				this.options.conversationUi.isExecutionControlSocketInstanceConfirmed(
					failure.serverInstanceId,
				);
			if (!instanceConfirmed) await this.#reconcileSteerTranscript(chatId);
			if (!this.#hasChat(chatId)) throw error;
			this.options.chatState.appendLocalNoticeForChat(
				chatId,
				'error',
				!instanceConfirmed || failure.deliveryOutcome === 'unknown' || !failure.structured
					? m.chat_notice_steer_outcome_unconfirmed()
					: steerFailureNotice(error),
			);
			throw error;
		}
	}

	#transcriptViewId(chatId: string): string {
		const transcriptViewId = this.options.chatState.getCursorForChat(chatId).transcriptViewId;
		if (!transcriptViewId) throw new Error(`Transcript view is not loaded for ${chatId}`);
		return transcriptViewId;
	}

	async #reconcileSteerTranscript(chatId: string): Promise<void> {
		if (!this.#hasChat(chatId)) return;
		try {
			await this.options.chatState.loadMessages(chatId);
		} catch {
			// A later WebSocket reconnect or chat activation retries the authoritative snapshot.
		}
	}

	#appendUnconfirmedSteerNotice(chatId: string): void {
		if (!this.#hasChat(chatId)) return;
		this.options.chatState.appendLocalNoticeForChat(
			chatId,
			'error',
			m.chat_notice_steer_outcome_unconfirmed(),
		);
	}

	#applyMutationErrorControl(chatId: string, error: unknown): void {
		if (!this.#hasChat(chatId)) return;
		const control = controlFromMutationError(error);
		if (control) this.options.conversationUi.setExecutionControlFromRefresh(chatId, control);
	}

	#hasChat(chatId: string): boolean {
		return Boolean(this.options.sessions.byId[chatId]);
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
	)
		return null;
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
