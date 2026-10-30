import type { ChatTranscriptActivity } from '$shared/chat-transcript-activity';

export interface ChatTranscriptActivityPort {
	patchPreview(chatId: string, content: string, timestamp?: string): void;
	patchActivity(chatId: string, timestamp: string): void;
}

// Applies a committed span's server-derived activity to the chat list. Bodies
// and summaries carry the same activity, so displayed and undisplayed chats
// update the sidebar identically. Returns the span's latest activity time.
export function applyChatTranscriptActivity(
	sessions: ChatTranscriptActivityPort,
	chatId: string,
	activity: ChatTranscriptActivity,
): string | null {
	const { preview, lastActivityAt } = activity;
	if (preview) {
		sessions.patchPreview(chatId, preview.content, lastActivityAt ?? preview.timestamp);
	} else if (lastActivityAt) {
		sessions.patchActivity(chatId, lastActivityAt);
	}
	return lastActivityAt;
}
