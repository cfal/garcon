import { describe, expect, it } from 'vitest';
import { createChatMessagesAccumulator } from '../router.svelte';
import { AssistantMessage } from '$shared/chat-types';
import type { ChatMessage } from '$shared/chat-types';
import { ChatMessagesMessage } from '$shared/ws-events';
import type { TranscriptMessage } from '$shared/chat-view';

function entry(ordinal: number, message: ChatMessage): TranscriptMessage {
	return { ordinal, message };
}

describe('createChatMessagesAccumulator', () => {
	it('coalesces same-drain message chunks into one state write', () => {
		let current: ChatMessage[] = [];
		let writes = 0;
		const accumulator = createChatMessagesAccumulator({
			applyChatMessages: (_chatId, _transcriptViewId, messages) => {
				writes += 1;
				current = [...current, ...messages.map((item) => item.message)];
				return 'applied';
			},
			reloadChatTranscript: () => {},
		});

		accumulator.enqueue(
			new ChatMessagesMessage('chat-a', 'generation-1', [
				entry(1, new AssistantMessage('2024-01-01T00:00:00Z', 'first')),
				], 1, 1, []),
		);
		accumulator.enqueue(
			new ChatMessagesMessage('chat-a', 'generation-1', [
				entry(2, new AssistantMessage('2024-01-01T00:00:01Z', 'second')),
				], 2, 2, []),
		);
		accumulator.flush();

		expect(writes).toBe(1);
		expect(current.map((message) => (message as AssistantMessage).content)).toEqual([
			'first',
			'second',
		]);
	});

	it('flushes queued chunks when the chat id changes', () => {
		const writes: Array<{ chatId: string; transcriptViewId: string; contents: string[] }> = [];
		const accumulator = createChatMessagesAccumulator({
			applyChatMessages: (chatId, transcriptViewId, messages) => {
				writes.push({
					chatId,
					transcriptViewId,
					contents: messages.map((item) => (item.message as AssistantMessage).content),
				});
				return 'applied';
			},
			reloadChatTranscript: () => {},
		});

		accumulator.enqueue(
			new ChatMessagesMessage('chat-a', 'generation-1', [
				entry(1, new AssistantMessage('2024-01-01T00:00:00Z', 'first')),
				], 1, 1, []),
		);
		accumulator.enqueue(
			new ChatMessagesMessage('chat-b', 'generation-1', [
				entry(1, new AssistantMessage('2024-01-01T00:00:01Z', 'second')),
				], 1, 1, []),
		);
		accumulator.flush();

		expect(writes).toEqual([
			{ chatId: 'chat-a', transcriptViewId: 'generation-1', contents: ['first'] },
			{ chatId: 'chat-b', transcriptViewId: 'generation-1', contents: ['second'] },
		]);
	});

	it('reloads the transcript when accumulated messages report a generation change', () => {
		const reloads: string[] = [];
		const accumulator = createChatMessagesAccumulator({
			applyChatMessages: () => 'view-changed',
			reloadChatTranscript: (chatId) => reloads.push(chatId),
		});

		accumulator.enqueue(
			new ChatMessagesMessage('chat-a', 'generation-2', [
				entry(1, new AssistantMessage('2024-01-01T00:00:00Z', 'fresh')),
				], 1, 1, []),
		);
		accumulator.flush();

		expect(reloads).toEqual(['chat-a']);
	});

	it('does not write when no output was queued', () => {
		let writes = 0;
		const accumulator = createChatMessagesAccumulator({
			applyChatMessages: () => {
				writes += 1;
				return 'applied';
			},
			reloadChatTranscript: () => {},
		});

		accumulator.flush();

		expect(writes).toBe(0);
	});
});
