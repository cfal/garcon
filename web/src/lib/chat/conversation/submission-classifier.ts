import type { ChatExecutionControlState } from '$shared/chat-execution-control';

export type AcceptedInputRoute =
	| 'draft'
	| 'direct'
	| 'queue'
	| 'queue-attachments-unsupported';

export interface SubmissionClassificationInput {
	isDraft: boolean;
	isProcessing: boolean;
	control: ChatExecutionControlState | null;
	hasAttachments: boolean;
}

export function classifySubmission(input: SubmissionClassificationInput): AcceptedInputRoute {
	if (input.isDraft) return 'draft';

	const queue = input.control?.queue ?? null;
	const queueIsEmpty = (queue?.entries.length ?? 0) === 0 && queue?.dispatchingEntryId == null;
	const queueIsUnpaused = queue?.pause == null;
	const requiresQueue =
		input.isProcessing || !queueIsEmpty || !queueIsUnpaused;

	if (!requiresQueue) return 'direct';
	if (input.hasAttachments) return 'queue-attachments-unsupported';
	return 'queue';
}
