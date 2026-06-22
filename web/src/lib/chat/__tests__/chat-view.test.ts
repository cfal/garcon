import { describe, expect, it } from 'vitest';
import {
	applyChatViewMessages,
	parseChatViewMessage,
	parseChatViewMessages,
	type ChatViewMessage,
} from '$shared/chat-view';
import { AssistantMessage, ErrorMessage } from '$shared/chat-types';

const message = { type: 'assistant-message', timestamp: '2025-01-01T00:00:00Z', content: 'hi' };

describe('chat view helpers', () => {
	it('parses a valid chat view message envelope', () => {
		const entry = parseChatViewMessage({ seq: 1, message });

		expect(entry?.seq).toBe(1);
		expect(entry?.message).toBeInstanceOf(AssistantMessage);
		expect((entry?.message as AssistantMessage).content).toBe('hi');
	});

	it('rejects malformed or non-increasing batches', () => {
		expect(parseChatViewMessages([{ seq: 0, message }])).toBeNull();
		expect(parseChatViewMessages([
			{ seq: 1, message },
			{ seq: 1, message },
		])).toBeNull();
	});

	it('keeps unknown inner messages as error placeholders', () => {
		const entries = parseChatViewMessages([
			{ seq: 1, message: { type: 'future-message', timestamp: '2025-01-01T00:00:00Z' } },
		]);

		expect(entries?.[0].message).toBeInstanceOf(ErrorMessage);
	});

	it('applies only messages beyond the current cursor', () => {
		const current: ChatViewMessage[] = [{ seq: 1, message: parseChatViewMessage({ seq: 1, message })!.message }];
		const incoming: ChatViewMessage[] = [
			{ seq: 1, message: parseChatViewMessage({ seq: 1, message })!.message },
			{ seq: 2, message: parseChatViewMessage({ seq: 2, message })!.message },
		];

		const applied = applyChatViewMessages(current, incoming, 1);

		expect(applied.status).toBe('applied');
		expect(applied.changed).toBe(true);
		expect(applied.messages.map((entry) => entry.seq)).toEqual([1, 2]);
		expect(applied.lastSeq).toBe(2);
	});

	it('detects a gap before the first new message', () => {
		const current: ChatViewMessage[] = [{ seq: 1, message: parseChatViewMessage({ seq: 1, message })!.message }];
		const incoming: ChatViewMessage[] = [
			{ seq: 3, message: parseChatViewMessage({ seq: 3, message })!.message },
		];

		const applied = applyChatViewMessages(current, incoming, 1);

		expect(applied).toMatchObject({
			status: 'gap-detected',
			changed: false,
			lastSeq: 1,
			expectedSeq: 2,
			receivedSeq: 3,
		});
		expect(applied.messages).toBe(current);
	});

	it('detects an internal gap in a new message batch', () => {
		const current: ChatViewMessage[] = [{ seq: 1, message: parseChatViewMessage({ seq: 1, message })!.message }];
		const incoming: ChatViewMessage[] = [
			{ seq: 2, message: parseChatViewMessage({ seq: 2, message })!.message },
			{ seq: 4, message: parseChatViewMessage({ seq: 4, message })!.message },
		];

		const applied = applyChatViewMessages(current, incoming, 1);

		expect(applied).toMatchObject({
			status: 'gap-detected',
			changed: false,
			lastSeq: 1,
			expectedSeq: 3,
			receivedSeq: 4,
		});
		expect(applied.messages).toBe(current);
	});
});
