import type { ChatExecutionControlState } from '$shared/chat-execution-control';

export type AcceptedInputRoute =
	| 'draft'
	| 'direct'
	| 'active'
	| 'queue'
	| 'queue-attachments-unsupported';

export interface SubmissionClassificationInput {
	isDraft: boolean;
	isProcessing: boolean;
	control: ChatExecutionControlState | null;
	isActiveDeliveryInput: boolean;
	isRecoveredContinuationEligible: boolean;
	hasAttachments: boolean;
}

export function classifySubmission(input: SubmissionClassificationInput): AcceptedInputRoute {
	if (input.isDraft) return 'draft';

	const queue = input.control?.queue ?? null;
	const queueIsEmpty = (queue?.entries.length ?? 0) === 0 && queue?.dispatchingEntryId == null;
	const queueIsUnpaused = queue?.pause == null;
	const hasRecoveredContinuation = input.control?.recoveredInputContinuation != null;
	const canConsumeEmptyContinuation = Boolean(
		input.isRecoveredContinuationEligible &&
			hasRecoveredContinuation &&
			queue &&
			queueIsEmpty &&
			queueIsUnpaused,
	);
	const requiresQueue =
		!canConsumeEmptyContinuation &&
		(input.isProcessing || !queueIsEmpty || !queueIsUnpaused || hasRecoveredContinuation);

	if (!requiresQueue) return 'direct';
	if (input.hasAttachments) return 'queue-attachments-unsupported';
	if (
		input.isProcessing &&
		input.isActiveDeliveryInput &&
		queueIsEmpty &&
		queueIsUnpaused &&
		!hasRecoveredContinuation
	) {
		return 'active';
	}
	return 'queue';
}
