import type { ChatExecutionControlState } from '$shared/chat-execution-control';

export type AcceptedInputRoute =
	'draft' | 'direct' | 'handoff-requires-idle' | 'queue' | 'queue-attachments-unsupported';

export interface SubmissionClassificationInput {
	isDraft: boolean;
	isProcessing: boolean;
	handoffPending: boolean;
	control: ChatExecutionControlState | null;
	hasAttachments: boolean;
}

export function requiresQueuedSubmission(
	input: Pick<SubmissionClassificationInput, 'isProcessing' | 'control'>,
): boolean {
	const queue = input.control?.queue ?? null;
	return input.isProcessing || (queue?.entries.length ?? 0) > 0 || queue?.pause != null;
}

export function classifySubmission(input: SubmissionClassificationInput): AcceptedInputRoute {
	if (input.isDraft) return 'draft';

	const requiresQueue = requiresQueuedSubmission(input);

	if (input.handoffPending && requiresQueue) return 'handoff-requires-idle';
	if (!requiresQueue) return 'direct';
	if (input.hasAttachments) return 'queue-attachments-unsupported';
	return 'queue';
}
