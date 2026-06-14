import { describe, expect, it } from 'vitest';
import { ChatState } from '../state.svelte';
import { AssistantMessage, ErrorMessage, UserMessage, type ChatMessage } from '$shared/chat-types';
import type { ChatMessageEvent } from '$shared/chat-events';

const TS = '2024-01-01T00:00:00.000Z';

function event(seq: number, message: ChatMessage, patch: Partial<ChatMessageEvent> = {}): ChatMessageEvent {
	return {
		appendSeq: seq,
		seq,
		messageId: `message-${seq}`,
		rev: 1,
		message,
		...patch,
	};
}

describe('ChatState', () => {
	it('starts with empty event state', () => {
		const chat = new ChatState();

		expect(chat.chatMessages).toEqual([]);
		expect(chat.visibleRows).toEqual([]);
		expect(chat.getCursor()).toEqual({ logId: '', lastAppendSeq: 0 });
		expect(chat.hasMoreMessages).toBe(false);
	});

	it('applies event-log creations and revisions by messageId', () => {
		const chat = new ChatState();
		const first = event(1, new UserMessage(TS, 'hello'), { messageId: 'user-1' });
		const revision = event(2, new UserMessage(TS, 'hello delivered'), {
			messageId: 'user-1',
			seq: 1,
			rev: 2,
		});

		expect(chat.applyEvents('log-1', [first])).toBe('applied');
		expect(chat.applyEvents('log-1', [revision])).toBe('applied');

		expect(chat.chatMessages).toHaveLength(1);
		expect((chat.chatMessages[0] as UserMessage).content).toBe('hello delivered');
		expect(chat.getCursor()).toEqual({ logId: 'log-1', lastAppendSeq: 2 });
		expect(chat.visibleRows[0].id).toBe('user-1');
	});

	it('signals a generation change when incoming logId changes', () => {
		const chat = new ChatState();
		chat.applyEvents('log-1', [event(1, new UserMessage(TS, 'hello'))]);

		const result = chat.applyEvents('log-2', [event(1, new AssistantMessage(TS, 'new log'))]);

		expect(result).toBe('generation-changed');
		expect(chat.chatMessages).toEqual([]);
		expect(chat.getCursor()).toEqual({ logId: 'log-2', lastAppendSeq: 0 });
	});

	it('overlays pending user inputs until the durable echo arrives', () => {
		const chat = new ChatState();
		chat.setPendingUserInputs([
			{
				chatId: 'chat-1',
				clientRequestId: 'req-1',
				clientMessageId: 'client-message-1',
				content: 'pending',
				createdAt: TS,
				deliveryStatus: 'accepted',
			},
		]);

		expect(chat.displayMessages).toHaveLength(1);
		expect(chat.visibleRows[0].id).toBe('pending:req-1');

		chat.applyEvents('log-1', [
			event(1, new UserMessage(TS, 'pending', undefined, { clientRequestId: 'req-1' }), {
				messageId: 'server-message-1',
			}),
		]);

		expect(chat.visiblePendingInputs).toEqual([]);
		expect(chat.displayMessages).toHaveLength(1);
		expect(chat.visibleRows[0].id).toBe('server-message-1');
	});

	it('keeps local notices out of durable chatMessages', () => {
		const chat = new ChatState();
		chat.applyEvents('log-1', [event(1, new AssistantMessage(TS, 'server'))]);

		chat.appendErrorMessage('local failure');

		expect(chat.chatMessages).toHaveLength(1);
		expect(chat.displayMessages).toHaveLength(2);
		expect(chat.displayMessages[1]).toBeInstanceOf(ErrorMessage);
	});

	it('persists and restores the event cursor with the visible event window', () => {
		const chatId = 'persist-chat';
		localStorage.clear();
		const chat = new ChatState();
		chat.applyEvents('log-1', [
			event(1, new UserMessage(TS, 'first'), { messageId: 'first' }),
			event(2, new UserMessage(TS, 'second'), { messageId: 'second' }),
		]);

		chat.persistMessages(chatId);
		const restored = new ChatState();
		const result = restored.restoreMessages(chatId);

		expect(result).toEqual({ count: 2, stale: false });
		expect(restored.getCursor()).toEqual({ logId: 'log-1', lastAppendSeq: 2 });
		expect(restored.visibleRows.map((row) => row.id)).toEqual(['first', 'second']);
		localStorage.clear();
	});

	it('resetForNewChat clears event, pending, and local state', () => {
		const chat = new ChatState();
		chat.applyEvents('log-1', [event(1, new UserMessage(TS, 'hello'))]);
		chat.appendLocalAssistantMessage('local');
		chat.isUserScrolledUp = true;

		chat.resetForNewChat();

		expect(chat.chatMessages).toEqual([]);
		expect(chat.displayMessages).toEqual([]);
		expect(chat.getCursor()).toEqual({ logId: '', lastAppendSeq: 0 });
		expect(chat.isUserScrolledUp).toBe(false);
	});
});
