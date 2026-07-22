import { beforeEach, describe, expect, it, vi } from 'vitest';

import { reloadChatFromNative, type ChatReloadPort } from '$lib/chat/conversation/reload-chat.js';
import { ActiveTranscriptState } from '$lib/chat/transcript/active-transcript-state.svelte.js';
import { getChatMessages } from '$lib/api/chats.js';
import { AssistantMessage } from '$shared/chat-types';

vi.mock('$lib/api/chats.js', () => ({
	getChatMessages: vi.fn(),
}));

const TS = '2024-01-01T00:00:00.000Z';

function wsWithResponse(response: Record<string, unknown>): ChatReloadPort {
	return {
		sendRequest: vi.fn().mockResolvedValue(response),
	} satisfies ChatReloadPort;
}

describe('reloadChatFromNative', () => {
	beforeEach(() => {
		localStorage.clear();
		vi.mocked(getChatMessages).mockReset();
	});

	it('keeps older capped transcript pages reachable after a correlated reload', async () => {
		const ws = wsWithResponse({
			type: 'chat-reloaded',
			clientRequestId: 'req-1',
			chatId: 'chat-1',
			generationId: 'generation-2',
			lastSeq: 4,
			pageOldestSeq: 3,
			hasMore: true,
			messages: [
				{
					seq: 3,
					message: { type: 'assistant-message', timestamp: TS, content: 'three' },
				},
				{
					seq: 4,
					message: { type: 'assistant-message', timestamp: TS, content: 'four' },
				},
			],
		});
		vi.mocked(getChatMessages).mockResolvedValue({
			chatId: 'chat-1',
			generationId: 'generation-2',
			lastSeq: 4,
			pageOldestSeq: 1,
			hasMore: false,
			limit: 50,
			pendingUserInputs: [],
			messages: [
				{ seq: 1, message: new AssistantMessage(TS, 'one') },
				{ seq: 2, message: new AssistantMessage(TS, 'two') },
			],
		});
		const chat = new ActiveTranscriptState();

		await reloadChatFromNative(ws, chat, 'chat-1');

		expect(ws.sendRequest).toHaveBeenCalledWith({
			type: 'chat-reload',
			chatId: 'chat-1',
		});
		expect(chat.getCursor()).toEqual({ generationId: 'generation-2', lastSeq: 4 });
		expect(chat.oldestSeq).toBe(3);
		expect(chat.hasMoreMessages).toBe(true);
		expect(chat.chatMessages[0]).toBeInstanceOf(AssistantMessage);
		expect(chat.chatMessages.map((message) => (message as AssistantMessage).content)).toEqual([
			'three',
			'four',
		]);
		expect(chat.transcriptCache.get('chat-1')?.lastSeq).toBe(4);

		await expect(chat.loadMoreMessages('chat-1')).resolves.toBe('loaded');

		expect(getChatMessages).toHaveBeenCalledWith({
			chatId: 'chat-1',
			limit: 50,
			beforeSeq: 3,
		});
		expect(chat.chatMessages.map((message) => (message as AssistantMessage).content)).toEqual([
			'one',
			'two',
			'three',
			'four',
		]);
		expect(chat.hasMoreMessages).toBe(false);
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

		await expect(reloadChatFromNative(ws, new ActiveTranscriptState(), 'chat-1')).rejects.toThrow(
			'Unexpected chat reload response',
		);
	});
});
