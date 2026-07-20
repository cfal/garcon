import { ApiError } from '$lib/api/client.js';
import { CommandOutcomeUnknownError } from './idempotent-command.js';
import type { ConversationSubmissionOutcome } from './conversation-submission-outcome.js';
import type { SessionControllerDeps } from './conversation-session-controller.svelte.js';

export interface SubmissionSettlementDeps {
	chatState: Pick<
		SessionControllerDeps['chatState'],
		| 'appendLocalNotice'
		| 'clearPendingUserInput'
		| 'updatePendingUserInputDeliveryStatus'
	>;
	composerState: Pick<
		SessionControllerDeps['composerState'],
		'inputText' | 'images' | 'saveDraft'
	>;
}

export interface SubmissionFailureContext {
	chatId: string;
	previousText: string;
	previousImages: File[];
	restoreComposerOnFailure: boolean;
}

export interface SubmissionFailureOptions {
	clientRequestId?: string;
	unknownNotice: string;
	rejectedNotice(error: unknown): string;
	clearPendingOnAdmissionConflict?: boolean;
	refreshControl?: () => Promise<void>;
	restoreRejected?: () => void;
	onRejected?: () => void | Promise<void>;
}

export async function settleSubmissionFailure(
	deps: SubmissionSettlementDeps,
	context: SubmissionFailureContext,
	error: unknown,
	options: SubmissionFailureOptions,
): Promise<ConversationSubmissionOutcome> {
	const outcomeUnknown = error instanceof CommandOutcomeUnknownError;
	const admissionConflict =
		options.clearPendingOnAdmissionConflict === true && isExecutionControlAdmissionConflict(error);

	if (options.clientRequestId) {
		if (admissionConflict) {
			deps.chatState.clearPendingUserInput(options.clientRequestId);
			if (options.refreshControl) await options.refreshControl();
		} else {
			deps.chatState.updatePendingUserInputDeliveryStatus(
				options.clientRequestId,
				outcomeUnknown ? 'unconfirmed' : 'failed',
			);
		}
	}

	if (!outcomeUnknown) await options.onRejected?.();
	if (context.restoreComposerOnFailure && !outcomeUnknown) {
		if (options.restoreRejected) {
			options.restoreRejected();
		} else {
			deps.composerState.inputText = context.previousText;
			deps.composerState.images = context.previousImages;
			deps.composerState.saveDraft(context.chatId);
		}
	}

	deps.chatState.appendLocalNotice(
		'error',
		outcomeUnknown ? options.unknownNotice : options.rejectedNotice(error),
	);
	if (outcomeUnknown && options.refreshControl) void options.refreshControl();
	return outcomeUnknown ? 'unknown' : 'rejected';
}

function isExecutionControlAdmissionConflict(error: unknown): boolean {
	return (
		error instanceof ApiError &&
		error.retryable &&
		error.errorCode === 'SESSION_BUSY'
	);
}
