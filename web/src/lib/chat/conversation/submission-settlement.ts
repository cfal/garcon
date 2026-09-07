import { ApiError } from '$lib/api/client.js';
import { CommandOutcomeUnknownError } from './idempotent-command.js';
import type { ConversationSubmissionOutcome } from './conversation-submission-outcome.js';
import type { SessionControllerDeps } from './conversation-session-controller.svelte.js';

export interface SubmissionSettlementDeps {
	chatState: Pick<
		SessionControllerDeps['chatState'],
		'appendLocalNoticeForChat' | 'clearOptimisticUserInput'
	>;
	composerState: Pick<SessionControllerDeps['composerState'], 'restoreDraftIfRevision'>;
}

export interface SubmissionFailureContext {
	chatId: string;
	previousText: string;
	previousImages: File[];
	ownsComposer: boolean;
}

export interface SubmissionFailureOptions {
	clientMessageId?: string;
	unknownNotice: string;
	rejectedNotice(error: unknown): string;
	refreshOnAdmissionConflict?: boolean;
	composerRevisionAfterClear?: number | null;
	refreshControl?: () => Promise<void>;
	restoreRejected?: () => void;
	onRejected?: (error: unknown) => void | Promise<void>;
}

export async function settleSubmissionFailure(
	deps: SubmissionSettlementDeps,
	context: SubmissionFailureContext,
	error: unknown,
	options: SubmissionFailureOptions,
): Promise<ConversationSubmissionOutcome> {
	const outcomeUnknown = error instanceof CommandOutcomeUnknownError;
	const admissionConflict =
		options.refreshOnAdmissionConflict === true && isExecutionControlAdmissionConflict(error);

	if (options.clientMessageId && !outcomeUnknown) {
		deps.chatState.clearOptimisticUserInput(options.clientMessageId);
		if (admissionConflict && options.refreshControl) await options.refreshControl();
	}

	if (!outcomeUnknown) await options.onRejected?.(error);
	if (context.ownsComposer && !outcomeUnknown) {
		if (options.restoreRejected) {
			options.restoreRejected();
		} else if (typeof options.composerRevisionAfterClear === 'number') {
			deps.composerState.restoreDraftIfRevision(
				context.chatId,
				options.composerRevisionAfterClear,
				context.previousText,
				context.previousImages,
			);
		}
	}

	deps.chatState.appendLocalNoticeForChat(
		context.chatId,
		'error',
		outcomeUnknown ? options.unknownNotice : options.rejectedNotice(error),
	);
	if (outcomeUnknown && options.refreshControl) void options.refreshControl();
	return outcomeUnknown ? 'unknown' : 'rejected';
}

function isExecutionControlAdmissionConflict(error: unknown): boolean {
	return error instanceof ApiError && error.retryable && error.errorCode === 'SESSION_BUSY';
}
