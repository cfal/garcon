import { AssistantMessage, UserMessage, type ChatMessage } from '$shared/chat-types';

export interface ChatMessageBatchActivityPort {
	patchPreview(chatId: string, content: string, timestamp?: string): void;
	patchActivity(chatId: string, timestamp: string): void;
}

export function extractPreviewFirstLine(text: string): string {
	if (!text) return '';
	const newline = text.indexOf('\n');
	if (newline < 0) return text.trim();
	return text.slice(0, newline).trim();
}

// Selects the same conversational preview types as durable chat metadata.
export function selectPreviewFromBatch(
	messages: readonly ChatMessage[],
): { content: string; timestamp: string } | null {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message instanceof AssistantMessage || message instanceof UserMessage) {
			return {
				content: extractPreviewFirstLine(String(message.content || '')).slice(0, 200),
				timestamp: message.timestamp,
			};
		}
	}
	return null;
}

export function selectLatestActivityTimestampFromBatch(
	messages: readonly ChatMessage[],
): string | null {
	for (let index = messages.length - 1; index >= 0; index--) {
		const timestamp = messages[index]?.timestamp;
		if (timestamp) return timestamp;
	}
	return null;
}

export function applyChatMessageBatchActivity(
	sessions: ChatMessageBatchActivityPort,
	chatId: string,
	messages: readonly ChatMessage[],
): string | null {
	const preview = selectPreviewFromBatch(messages);
	const activityTimestamp = selectLatestActivityTimestampFromBatch(messages);
	if (preview) {
		sessions.patchPreview(chatId, preview.content, activityTimestamp ?? preview.timestamp);
	} else if (activityTimestamp) {
		sessions.patchActivity(chatId, activityTimestamp);
	}
	return activityTimestamp;
}
