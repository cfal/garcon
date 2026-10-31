// Requests one bounded transcript replay page over the primary socket.

import { ChatSubscribedMessage, parseServerWsMessage } from '$shared/ws-events';
import type { TranscriptReplayRequest } from '$lib/chat/transcript/cached-transcript-resume.js';

export interface TranscriptReplaySocket {
	sendRequest(message: object): Promise<Record<string, unknown>>;
}

// Rejects a page that does not continue the requested cursor, so callers never
// apply a range the server did not prove contiguous with their applied frontier.
export async function requestTranscriptReplayPage(
	ws: TranscriptReplaySocket,
	request: TranscriptReplayRequest,
): Promise<ChatSubscribedMessage> {
	const raw = await ws.sendRequest({
		type: 'chat-subscribe',
		chatId: request.chatId,
		transcriptViewId: request.transcriptViewId,
		afterOrdinal: request.afterOrdinal,
		...(request.throughOrdinal === undefined ? {} : { throughOrdinal: request.throughOrdinal }),
		...(request.purpose === undefined ? {} : { purpose: request.purpose }),
	});
	const message = parseServerWsMessage(raw);
	if (
		!(message instanceof ChatSubscribedMessage) ||
		message.chatId !== request.chatId ||
		message.transcriptViewId !== request.transcriptViewId
	) {
		throw new Error('Unexpected chat-subscribe response');
	}
	if (message.firstOrdinal !== request.afterOrdinal + 1) {
		throw new Error('Transcript replay page does not continue its requested cursor');
	}
	if (request.throughOrdinal !== undefined && message.throughOrdinal !== request.throughOrdinal) {
		throw new Error('Transcript replay watermark changed during continuation');
	}
	if (
		message.nextAfterOrdinal < request.afterOrdinal ||
		(message.hasMore && message.nextAfterOrdinal === request.afterOrdinal)
	) {
		throw new Error('Transcript replay page did not advance its requested cursor');
	}
	return message;
}
