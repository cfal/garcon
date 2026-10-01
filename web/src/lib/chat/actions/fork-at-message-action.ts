import type { TranscriptMessage } from '$shared/chat-view';

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
	entries: readonly TranscriptMessage[],
	transcriptViewId: string,
	ordinal: number,
): ForkAtMessageSelection | null {
	const selected = entries.find((entry) => entry.ordinal === ordinal);
	if (!selected || !transcriptViewId) return null;
	const clientMessageId = forkClientMessageId(selected);
	const unique = clientMessageId && entries.filter(
		(entry) => forkClientMessageId(entry) === clientMessageId,
	).length === 1;
	return { ordinal, transcriptViewId, clientMessageId: unique ? clientMessageId : null };
}

export function remapForkAtMessage(
	entries: readonly TranscriptMessage[],
	transcriptViewId: string,
	selection: ForkAtMessageSelection,
): ForkAtMessageSelection | null {
	// Content and tool IDs cannot identify a row across replaced, bounded history windows.
	if (!selection.clientMessageId || !transcriptViewId) return null;
	const matches = entries.filter(
		(entry) => forkClientMessageId(entry) === selection.clientMessageId,
	);
	if (matches.length !== 1) return null;
	return { ...selection, ordinal: matches[0]!.ordinal, transcriptViewId };
}

function forkClientMessageId({ message }: TranscriptMessage): string | null {
	return message.type === 'user-message' ? message.metadata?.clientMessageId ?? null : null;
}
