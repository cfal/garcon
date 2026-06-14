import { describe, expect, it } from 'vitest';
import {
	selectPreviewFromBatch,
	_extractFirstLine,
	createChatEventsAccumulator,
} from '../router.svelte';
import {
	UserMessage,
	AssistantMessage,
	ThinkingMessage,
	ToolResultMessage,
	UnknownToolUseMessage,
} from '$shared/chat-types';
import type { ChatMessage } from '$shared/chat-types';
import { ChatEventsMessage } from '$shared/ws-events';
import type { ChatMessageEvent } from '$shared/chat-events';

function event(seq: number, message: ChatMessage): ChatMessageEvent {
	return {
		appendSeq: seq,
		seq,
		messageId: `message-${seq}`,
		rev: 1,
		message,
	};
}

describe('extractFirstLine', () => {
	it('returns text before first newline', () => {
		expect(_extractFirstLine('first\nsecond\nthird')).toBe('first');
	});

	it('returns full text when no newline', () => {
		expect(_extractFirstLine('single line')).toBe('single line');
	});

	it('trims whitespace', () => {
		expect(_extractFirstLine('  padded  \nmore')).toBe('padded');
	});

	it('returns empty string for empty input', () => {
		expect(_extractFirstLine('')).toBe('');
	});

	it('handles leading newline', () => {
		expect(_extractFirstLine('\nfirst real line')).toBe('');
	});
});

describe('createChatEventsAccumulator', () => {
	it('coalesces same-drain event chunks into one event write', () => {
		let current: ChatMessage[] = [];
		let writes = 0;
		const accumulator = createChatEventsAccumulator({
			applyChatEvents: (_chatId, _logId, events) => {
				writes += 1;
				current = [...current, ...events.map((entry) => entry.message)];
				return 'applied';
			},
			reloadChatSnapshot: () => {},
		});

		accumulator.enqueue(
			new ChatEventsMessage(
				'chat-a',
				'log-1',
				[event(1, new AssistantMessage('2024-01-01T00:00:00Z', 'first'))],
			),
		);
		accumulator.enqueue(
			new ChatEventsMessage(
				'chat-a',
				'log-1',
				[event(2, new AssistantMessage('2024-01-01T00:00:01Z', 'second'))],
			),
		);
		accumulator.flush();

		expect(writes).toBe(1);
		expect(current.map((message) => (message as AssistantMessage).content)).toEqual([
			'first',
			'second',
		]);
	});

	it('does not write when no output was queued', () => {
		let writes = 0;
		const accumulator = createChatEventsAccumulator({
			applyChatEvents: () => {
				writes += 1;
				return 'applied';
			},
			reloadChatSnapshot: () => {},
		});

		accumulator.flush();

		expect(writes).toBe(0);
	});
});

describe('selectPreviewFromBatch', () => {
	it('returns first line from the latest assistant message', () => {
		const messages: ChatMessage[] = [
			new UserMessage('2024-01-01T00:00:00Z', 'hello'),
			new UnknownToolUseMessage('2024-01-01T00:00:01Z', 't1', 'ls', {}),
			new AssistantMessage('2024-01-01T00:00:02Z', 'first line\nsecond line'),
		];

		const preview = selectPreviewFromBatch(messages);
		expect(preview).toEqual({ content: 'first line', timestamp: '2024-01-01T00:00:02Z' });
	});

	it('returns full content when no newline present', () => {
		const messages: ChatMessage[] = [
			new AssistantMessage('2024-01-01T00:00:00Z', 'single line response'),
		];

		const preview = selectPreviewFromBatch(messages);
		expect(preview).toEqual({ content: 'single line response', timestamp: '2024-01-01T00:00:00Z' });
	});

	it('returns null when no displayable message exists', () => {
		const messages: ChatMessage[] = [
			new UnknownToolUseMessage('2024-01-01T00:00:01Z', 't1', 'ls', {}),
			new ToolResultMessage('2024-01-01T00:00:02Z', 't1', {}, false),
		];

		expect(selectPreviewFromBatch(messages)).toBeNull();
	});

	it('returns first line of thinking content when no assistant/user message is newer', () => {
		const messages: ChatMessage[] = [
			new UserMessage('2024-01-01T00:00:00Z', 'hello'),
			new ThinkingMessage('2024-01-01T00:00:01Z', 'working on it\nstep two'),
		];

		const preview = selectPreviewFromBatch(messages);
		expect(preview).toEqual({ content: 'working on it', timestamp: '2024-01-01T00:00:01Z' });
	});

	it('truncates content to 200 characters', () => {
		const longContent = 'a'.repeat(300);
		const messages: ChatMessage[] = [new AssistantMessage('2024-01-01T00:00:00Z', longContent)];

		const preview = selectPreviewFromBatch(messages);
		expect(preview?.content.length).toBe(200);
	});

	it('returns null for empty message array', () => {
		expect(selectPreviewFromBatch([])).toBeNull();
	});
});
