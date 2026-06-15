import { beforeEach, describe, expect, it, vi } from 'vitest';

import { reloadChatFromNative } from '../reload-chat';
import { ChatState } from '../state.svelte';
import { AssistantMessage } from '$shared/chat-types';
import type { WsConnection } from '$lib/ws/connection.svelte';

const TS = '2024-01-01T00:00:00.000Z';

function wsWithResponse(response: Record<string, unknown>): WsConnection {
	return {
		sendRequest: vi.fn().mockResolvedValue(response),
	} as unknown as WsConnection;
}

describe('reloadChatFromNative', () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it('applies a correlated reload response to selected chat state', async () => {
		const ws = wsWithResponse({
			type: 'chat-reloaded',
			clientRequestId: 'req-1',
			chatId: 'chat-1',
			generationId: 'generation-2',
			lastSeq: 1,
			pageOldestSeq: 1,
			hasMore: false,
			messages: [{
				seq: 1,
				message: { type: 'assistant-message', timestamp: TS, content: 'native' },
			}],
		});
		const chat = new ChatState();

		await reloadChatFromNative(ws, chat, 'chat-1');

		expect(ws.sendRequest).toHaveBeenCalledWith({
			type: 'chat-reload',
			chatId: 'chat-1',
		});
		expect(chat.getCursor()).toEqual({ generationId: 'generation-2', lastSeq: 1 });
		expect(chat.chatMessages[0]).toBeInstanceOf(AssistantMessage);
		expect((chat.chatMessages[0] as AssistantMessage).content).toBe('native');
		expect(chat.snapshotCache.restore('chat-1')?.lastSeq).toBe(1);
	});

	it('rejects unexpected reload responses', async () => {
		const ws = wsWithResponse({
			type: 'chat-subscribed',
			clientRequestId: 'req-1',
			chatId: 'chat-1',
			generationId: 'generation-1',
			mode: 'delta',
			messages: [],
			lastSeq: 0,
		});

		await expect(reloadChatFromNative(ws, new ChatState(), 'chat-1')).rejects.toThrow(
			'Unexpected chat reload response',
		);
	});
});
