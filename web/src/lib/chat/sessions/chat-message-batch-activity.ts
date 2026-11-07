import type { ChatTranscriptHeadUpdatedMessage } from '$shared/transcript-display-events';

export function applyTranscriptHeadActivity(sessions: ChatMessageBatchActivityPort, head: ChatTranscriptHeadUpdatedMessage): string | null {
	if (head.preview) sessions.patchPreview(head.chatId, head.preview.text, head.presentedActivityAt ?? head.preview.timestamp);
	else if (head.presentedActivityAt) sessions.patchActivity(head.chatId, head.presentedActivityAt);
	return head.presentedActivityAt;
}

export interface ChatMessageBatchActivityPort {
	patchPreview(chatId: string, content: string, timestamp?: string): void;
	patchActivity(chatId: string, timestamp: string): void;
}
