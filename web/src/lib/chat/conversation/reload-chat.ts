import {
	ChatReloadedMessage,
	ChatReloadProgressMessage,
	parseServerWsMessage,
	type ChatReloadProgress,
} from '$shared/ws-events';
import { ChatReloadCancelRequest } from '$shared/ws-requests';
import type { PrimaryWsClientMessage } from '$shared/ws-protocol';
import type { ActiveTranscriptState } from '$lib/chat/transcript/active-transcript-state.svelte.js';
import type { WsProgressRequest, WsRequestProgress } from '$lib/ws/connection.svelte.js';
import { WsRequestError } from '$lib/ws/ws-request-error.js';

// The server reports progress every second, so this only expires a reload
// whose server or connection has stopped answering.
const RELOAD_IDLE_TIMEOUT_MS = 30_000;

export interface ChatReloadPort {
	sendProgressRequest(
		message: object,
		progress: WsRequestProgress,
	): WsProgressRequest<Record<string, unknown>>;
	sendMessage(message: PrimaryWsClientMessage): boolean;
}

export interface ChatReloadOptions {
	readonly signal: AbortSignal;
	readonly onProgress: (progress: ChatReloadProgress) => void;
}

export type ChatReloadOutcome = 'reloaded' | 'cancelled';

/**
 * Replaces the chat's transcript with its native history. Aborting the signal
 * asks the server to stop; the server's answer still decides the outcome,
 * because a reload that is already saving completes.
 */
export async function reloadChatFromNative(
	ws: ChatReloadPort,
	chatState: ActiveTranscriptState,
	chatId: string,
	options: ChatReloadOptions,
): Promise<ChatReloadOutcome> {
	const request = ws.sendProgressRequest(
		{ type: 'chat-reload', chatId },
		{
			type: 'chat-reload-progress',
			idleTimeoutMs: RELOAD_IDLE_TIMEOUT_MS,
			onProgress: (raw) => {
				const progress = parseServerWsMessage(raw);
				if (progress instanceof ChatReloadProgressMessage && progress.chatId === chatId) {
					options.onProgress({ phase: progress.phase, rows: progress.rows });
				}
			},
		},
	);
	const cancel = () => ws.sendMessage(new ChatReloadCancelRequest(chatId, request.clientRequestId));
	options.signal.addEventListener('abort', cancel, { once: true });
	let raw: Record<string, unknown>;
	try {
		raw = await request.response;
	} catch (error) {
		if (error instanceof WsRequestError && error.code === 'REQUEST_CANCELLED') return 'cancelled';
		throw error;
	} finally {
		options.signal.removeEventListener('abort', cancel);
	}

	const message = parseServerWsMessage(raw);
	if (!(message instanceof ChatReloadedMessage) || message.chatId !== chatId) {
		throw new Error('Unexpected chat reload response');
	}

	chatState.replaceGeneration(chatId, message.transcriptViewId, message.messages, {
		lastOrdinal: message.lastOrdinal,
		pageOldestOrdinal: message.pageOldestOrdinal,
		pageNewestOrdinal: message.pageNewestOrdinal,
		nextBeforeOrdinal: message.nextBeforeOrdinal,
		hasMore: message.hasMore,
	});
	chatState.transcriptCache.markValidated(chatId);
	return 'reloaded';
}
