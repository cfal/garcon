import { describe, expect, it } from 'vitest';
import {
	applyChatMessageEvents,
	parseChatMessageEvent,
	parseChatMessageEvents,
	type ChatMessageEvent,
} from '$shared/chat-events';
import { AssistantMessage } from '$shared/chat-types';

describe('chat events', () => {
	it('parses unknown inner messages as visible error messages', () => {
		const event = parseChatMessageEvent({
			appendSeq: 1,
			seq: 1,
			messageId: 'message-1',
			rev: 1,
			message: {
				type: 'future-message',
				timestamp: '2026-06-01T00:00:00.000Z',
				payload: { unsupported: true },
			},
		});

		expect(event).toMatchObject({
			appendSeq: 1,
			seq: 1,
			messageId: 'message-1',
			rev: 1,
		});
		expect(event?.message.type).toBe('error');
	});

	it('rejects malformed event batches without partially advancing cursors', () => {
		expect(
			parseChatMessageEvents([
				{
					appendSeq: 1,
					seq: 1,
					messageId: 'message-1',
					rev: 1,
					message: {
						type: 'assistant-message',
						timestamp: '2026-06-01T00:00:00.000Z',
						content: 'ok',
					},
				},
				{
					appendSeq: 1,
					seq: 2,
					messageId: 'message-2',
					rev: 1,
					message: {
						type: 'assistant-message',
						timestamp: '2026-06-01T00:00:01.000Z',
						content: 'gap',
					},
				},
			]),
		).toBeNull();
	});

	it('applies revisions by stable message id and append cursor', () => {
		const original: ChatMessageEvent = {
			appendSeq: 1,
			seq: 1,
			messageId: 'message-1',
			rev: 1,
			message: new AssistantMessage('2026-06-01T00:00:00.000Z', 'draft'),
		};
		const revision: ChatMessageEvent = {
			appendSeq: 2,
			seq: 1,
			messageId: 'message-1',
			rev: 2,
			message: new AssistantMessage('2026-06-01T00:00:01.000Z', 'final'),
		};

		const applied = applyChatMessageEvents([original], [revision], 1);

		expect(applied.changed).toBe(true);
		expect(applied.lastAppendSeq).toBe(2);
		expect(applied.entries).toHaveLength(1);
		expect(applied.entries[0]).toMatchObject({
			appendSeq: 2,
			seq: 1,
			messageId: 'message-1',
			rev: 2,
		});
		expect(applied.entries[0].message.type).toBe('assistant-message');
		if (applied.entries[0].message.type !== 'assistant-message') {
			throw new Error('Expected assistant revision');
		}
		expect(applied.entries[0].message.content).toBe('final');
	});
});
