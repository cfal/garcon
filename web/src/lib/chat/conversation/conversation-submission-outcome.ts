export type ConversationSubmissionOutcome = 'accepted' | 'rejected' | 'unknown' | 'no-op';

export function isAcceptedConversationSubmission(outcome: ConversationSubmissionOutcome): boolean {
	return outcome === 'accepted';
}
