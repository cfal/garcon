import type { ChatExecutionControlState } from '$shared/chat-execution-control';

export type AcceptedInputRoute = 'draft' | 'direct' | 'queue';

export interface SubmissionClassificationInput {
	isDraft: boolean;
	isProcessing: boolean;
	control: ChatExecutionControlState | null;
}

export function requiresQueuedSubmission(
	input: Pick<SubmissionClassificationInput, 'isProcessing' | 'control'>,
): boolean {
	const queue = input.control?.queue ?? null;
	return input.isProcessing || (queue?.entries.length ?? 0) > 0 || queue?.pause != null;
}

export function classifySubmission(input: SubmissionClassificationInput): AcceptedInputRoute {
	if (input.isDraft) return 'draft';
	return requiresQueuedSubmission(input) ? 'queue' : 'direct';
}
