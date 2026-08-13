import { UserMessage, type ChatMessage } from '$shared/chat-types';
import type { ChatViewMessage } from '$shared/chat-view';
import { normalizePendingUserInput, type PendingUserInput } from '$shared/pending-user-input';

export interface ChatTranscriptRow {
	kind: 'message';
	id: string;
	message: ChatMessage;
	seq?: number;
}

export function sortPendingInputs(inputs: PendingUserInput[]): PendingUserInput[] {
	return inputs.slice().sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export function normalizePendingInputs(inputs: readonly unknown[]): PendingUserInput[] {
	return sortPendingInputs(
		inputs
			.map(normalizePendingUserInput)
			.filter((input): input is PendingUserInput => Boolean(input)),
	);
}

export function applyPendingDeliveryStatuses(
	entries: ChatViewMessage[],
	pendingInputs: PendingUserInput[],
): ChatViewMessage[] {
	const unsettledStatuses = new Map(
		pendingInputs
			.filter(
				(input) => input.deliveryStatus === 'failed' || input.deliveryStatus === 'unconfirmed',
			)
			.map((input) => [input.clientRequestId, input.deliveryStatus] as const),
	);
	if (unsettledStatuses.size === 0) return entries;

	return entries.map((entry) => {
		const message = entry.message;
		if (!(message instanceof UserMessage)) return entry;
		const clientRequestId = message.metadata?.clientRequestId;
		const deliveryStatus = clientRequestId ? unsettledStatuses.get(clientRequestId) : undefined;
		if (!deliveryStatus) return entry;
		return {
			...entry,
			message: new UserMessage(message.timestamp, message.content, message.images, {
				...message.metadata,
				deliveryStatus,
			}),
		};
	});
}

function pendingInputToMessage(input: PendingUserInput): UserMessage {
	const placeholderAttachments = input.attachments?.map((attachment) => ({
		name: attachment.name,
		mimeType: 'application/octet-stream',
		data: '',
	}));
	return new UserMessage(input.createdAt, input.content, input.images ?? placeholderAttachments, {
		clientRequestId: input.clientRequestId,
		turnId: input.turnId,
		deliveryStatus: input.deliveryStatus,
	});
}

function pendingInputToRow(input: PendingUserInput): ChatTranscriptRow {
	return {
		kind: 'message',
		id: `pending:${input.clientRequestId}`,
		message: pendingInputToMessage(input),
	};
}

export function mergeRowsWithPendingInputs(
	rows: ChatTranscriptRow[],
	pendingInputs: PendingUserInput[],
): ChatTranscriptRow[] {
	if (rows.length === 0) return pendingInputs.map(pendingInputToRow);

	const pendingRows = pendingInputs.map(pendingInputToRow);
	const merged: ChatTranscriptRow[] = [];
	let messageIndex = 0;
	let pendingIndex = 0;

	while (messageIndex < rows.length && pendingIndex < pendingRows.length) {
		const row = rows[messageIndex];
		const pending = pendingRows[pendingIndex];
		if (row.message.timestamp.localeCompare(pending.message.timestamp) < 0) {
			merged.push(row);
			messageIndex += 1;
		} else {
			merged.push(pending);
			pendingIndex += 1;
		}
	}

	if (messageIndex < rows.length) merged.push(...rows.slice(messageIndex));
	if (pendingIndex < pendingRows.length) merged.push(...pendingRows.slice(pendingIndex));
	return merged;
}
