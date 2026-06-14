import { ChatReloadedMessage, parseServerWsMessage } from '$shared/ws-events';
import type { ChatState } from '$lib/chat/state.svelte';
import type { WsConnection } from '$lib/ws/connection.svelte';

export async function reloadChatFromNative(
	ws: WsConnection,
	chatState: ChatState,
	chatId: string,
): Promise<void> {
	const raw = await ws.sendRequest<Record<string, unknown>>({
		type: 'chat-reload',
		chatId,
	});
	const message = parseServerWsMessage(raw);
	if (!(message instanceof ChatReloadedMessage) || message.chatId !== chatId) {
		throw new Error('Unexpected chat reload response');
	}

	chatState.replaceGeneration(message.logId, message.events, {
		lastAppendSeq: message.lastAppendSeq,
		localNotice: message.localNotice,
	});
	chatState.persistMessages(chatId);
	chatState.snapshotCache.markValidated(chatId);
}
