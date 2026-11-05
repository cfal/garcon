import type { DisplayBody } from '$shared/transcript-display-contract';
import type { DisplayOpenResponse } from '$shared/transcript-display-open';

interface ForkActionInput {
	supportsFork: boolean;
	supportsForkWhileRunning: boolean;
	isProcessing: boolean;
}

export interface ForkAtMessageSelection {
	ordinal: number;
	transcriptViewId: string;
	clientMessageId: string | null;
}

interface ForkAtMessageActionInput {
	supportsForkAtMessage: boolean;
	supportsForkWhileRunning: boolean;
	isProcessing: boolean;
}

function canForkInCurrentRunState(input: {
	isProcessing: boolean;
	supportsForkWhileRunning: boolean;
}): boolean {
	return !input.isProcessing || input.supportsForkWhileRunning;
}

export function canUseForkAction(input: ForkActionInput): boolean {
	return input.supportsFork && canForkInCurrentRunState(input);
}

export function canShowForkAtMessageAction(
	input: Pick<ForkAtMessageActionInput, 'supportsForkAtMessage'>,
): boolean {
	return input.supportsForkAtMessage;
}

export function canUseForkAtMessageAction(input: ForkAtMessageActionInput): boolean {
	return input.supportsForkAtMessage && canForkInCurrentRunState(input);
}

export function selectForkAtMessage(
	body: DisplayBody | undefined,
	transcriptViewId: string,
): ForkAtMessageSelection | null {
	if (!body || !transcriptViewId) return null;
	return { ordinal: body.ordinal, transcriptViewId, clientMessageId: body.submissionClientMessageId };
}

export function remapForkAtMessage(
	open: Pick<DisplayOpenResponse, 'transcriptViewId' | 'submissions'>,
	selection: ForkAtMessageSelection,
): ForkAtMessageSelection | null {
	if (!selection.clientMessageId) return null;
	const match = open.submissions.find(input => input.clientMessageId === selection.clientMessageId && input.ordinal !== null);
	return match?.ordinal ? { ...selection, ordinal: match.ordinal, transcriptViewId: open.transcriptViewId } : null;
}
