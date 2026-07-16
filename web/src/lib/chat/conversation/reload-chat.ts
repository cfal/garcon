import { ChatReloadedMessage, parseServerWsMessage } from '$shared/ws-events';
import type { ActiveTranscriptState } from '$lib/chat/transcript/active-transcript-state.svelte.js';

export interface ChatReloadPort {
	sendRequest(message: object): Promise<Record<string, unknown>>;
}

export async function reloadChatFromNative(
	ws: ChatReloadPort,
	chatState: ActiveTranscriptState,
	chatId: string,
): Promise<void> {
	const raw = await ws.sendRequest({
		type: 'chat-reload',
		chatId,
	});
	const message = parseServerWsMessage(raw);
	if (!(message instanceof ChatReloadedMessage) || message.chatId !== chatId) {
		throw new Error('Unexpected chat reload response');
	}

	chatState.replaceGeneration(chatId, message.generationId, message.messages, {
		lastSeq: message.lastSeq,
		pageOldestSeq: message.pageOldestSeq,
		hasMore: message.hasMore,
	});
	chatState.transcriptCache.markValidated(chatId);
}
