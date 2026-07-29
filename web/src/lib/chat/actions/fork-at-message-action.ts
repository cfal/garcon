import type { ChatViewMessage } from '$shared/chat-view';

interface ForkActionInput {
	supportsFork: boolean;
	supportsForkWhileRunning: boolean;
	isProcessing: boolean;
}

export interface ForkAtMessageSelection {
	seq: number;
	generationId: string;
	messageKey: string;
	occurrence: number;
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
	entries: readonly ChatViewMessage[],
	generationId: string,
	seq: number,
): ForkAtMessageSelection | null {
	const selectedIndex = entries.findIndex((entry) => entry.seq === seq);
	if (selectedIndex < 0 || !generationId) return null;
	const messageKey = forkMessageKey(entries[selectedIndex]!.message);
	const occurrence = entries
		.slice(0, selectedIndex + 1)
		.filter((entry) => forkMessageKey(entry.message) === messageKey)
		.length;
	return { seq, generationId, messageKey, occurrence };
}

export function remapForkAtMessage(
	entries: readonly ChatViewMessage[],
	generationId: string,
	selection: ForkAtMessageSelection,
): ForkAtMessageSelection | null {
	let occurrence = 0;
	for (const entry of entries) {
		if (forkMessageKey(entry.message) !== selection.messageKey) continue;
		occurrence += 1;
		if (occurrence === selection.occurrence) {
			return {
				seq: entry.seq,
				generationId,
				messageKey: selection.messageKey,
				occurrence,
			};
		}
	}
	return null;
}

function forkMessageKey(message: ChatViewMessage['message']): string {
	const record = message as unknown as Record<string, unknown>;
	const metadata = isRecord(record.metadata) ? record.metadata : null;
	if (message.type === 'user-message' && typeof metadata?.clientRequestId === 'string') {
		return `${message.type}:request:${metadata.clientRequestId}`;
	}
	if (typeof record.toolId === 'string') {
		return `${message.type}:tool:${record.toolId}`;
	}
	const { timestamp: _timestamp, metadata: _metadata, ...identity } = record;
	return `${message.type}:${JSON.stringify(identity)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}
