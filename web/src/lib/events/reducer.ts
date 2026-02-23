// Applies incoming finalized ChatMessage arrays to the current message list.

import type { ChatMessage } from '$shared/chat-types';

// Appends incoming messages to the current list.
export function applyChatMessages(
	current: ChatMessage[],
	incoming: ChatMessage[],
): ChatMessage[] {
	if (incoming.length === 0) return current;
	return [...current, ...incoming];
}
