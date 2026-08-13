import type { ChatExecutionControlState } from '$shared/chat-execution-control';

export type AcceptedInputRoute =
	| 'draft'
	| 'direct'
	| 'handoff-requires-idle'
	| 'queue'
	| 'queue-attachments-unsupported';

export interface SubmissionClassificationInput {
	isDraft: boolean;
	isProcessing: boolean;
	handoffPending: boolean;
	control: ChatExecutionControlState | null;
	hasAttachments: boolean;
}

export function classifySubmission(input: SubmissionClassificationInput): AcceptedInputRoute {
	if (input.isDraft) return 'draft';

	const queue = input.control?.queue ?? null;
	const queueIsEmpty = (queue?.entries.length ?? 0) === 0;
	const queueIsUnpaused = queue?.pause == null;
	const requiresQueue =
		input.isProcessing || !queueIsEmpty || !queueIsUnpaused;

	if (input.handoffPending && requiresQueue) return 'handoff-requires-idle';
	if (!requiresQueue) return 'direct';
	if (input.hasAttachments) return 'queue-attachments-unsupported';
	return 'queue';
}
