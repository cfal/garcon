import { beforeEach, describe, expect, it, vi } from 'vitest';

const getChatMessagesMock = vi.hoisted(() => vi.fn());

vi.mock('$lib/api/chats.js', () => ({
	getChatMessages: getChatMessagesMock,
}));

import { ChatState, INITIAL_VISIBLE_MESSAGES } from '../state.svelte';
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

function page(overrides: Partial<{
	logId: string;
	events: ChatMessageEvent[];
	lastAppendSeq: number;
	pageOldestSeq: number;
	hasMore: boolean;
	pendingUserInputs: unknown[];
	limit: number;
}> = {}) {
	const events = overrides.events ?? [];
	return {
		logId: overrides.logId ?? 'log-1',
		events,
		lastAppendSeq: overrides.lastAppendSeq ?? events.at(-1)?.appendSeq ?? 0,
		pageOldestSeq: overrides.pageOldestSeq ?? events[0]?.seq ?? 0,
		hasMore: overrides.hasMore ?? false,
		limit: overrides.limit ?? 20,
		pendingUserInputs: overrides.pendingUserInputs ?? [],
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function contentOf(message: ChatMessage): string {
	if (
		message instanceof UserMessage ||
		message instanceof AssistantMessage ||
		message instanceof ErrorMessage
	) {
		return message.content;
	}
	return '';
}

function messageContents(messages: ChatMessage[]): string[] {
	return messages.map(contentOf);
}

describe('ChatState', () => {
	beforeEach(() => {
		getChatMessagesMock.mockReset();
	});

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

	it('does not install pending inputs from a stale snapshot page', async () => {
		const chat = new ChatState();
		const first = deferred<ReturnType<typeof page>>();
		getChatMessagesMock.mockReturnValueOnce(first.promise);

		const load = chat.loadMessages('chat-1');
		chat.replaceGeneration('fresh-log', [
			event(1, new AssistantMessage(TS, 'fresh'), { messageId: 'fresh-1' }),
		], { lastAppendSeq: 1 });

		first.resolve(page({
			logId: 'old-log',
			events: [event(1, new UserMessage(TS, 'old'), { messageId: 'old-1' })],
			pendingUserInputs: [{
				chatId: 'chat-1',
				clientRequestId: 'req-old',
				content: 'old pending',
				createdAt: TS,
				deliveryStatus: 'accepted',
			}],
		}));

		await expect(load).resolves.toEqual(chat.chatMessages);
		expect(chat.getCursor()).toEqual({ logId: 'fresh-log', lastAppendSeq: 1 });
		expect(messageContents(chat.chatMessages)).toEqual(['fresh']);
		expect(chat.pendingUserInputs).toEqual([]);
	});

	it('refetches when a buffered event belongs to a newer generation', async () => {
		const chat = new ChatState();
		const first = deferred<ReturnType<typeof page>>();
		getChatMessagesMock
			.mockReturnValueOnce(first.promise)
			.mockResolvedValueOnce(page({
				logId: 'new-log',
				events: [event(1, new AssistantMessage(TS, 'new'), { messageId: 'new-1' })],
				pendingUserInputs: [{
					chatId: 'chat-1',
					clientRequestId: 'req-new',
					content: 'new pending',
					createdAt: TS,
					deliveryStatus: 'accepted',
				}],
			}));

		const load = chat.loadMessages('chat-1');
		chat.applyEvents('new-log', [
			event(1, new AssistantMessage(TS, 'new live'), { messageId: 'new-live-1' }),
		]);

		first.resolve(page({
			logId: 'old-log',
			events: [event(1, new UserMessage(TS, 'old'), { messageId: 'old-1' })],
			pendingUserInputs: [{
				chatId: 'chat-1',
				clientRequestId: 'req-old',
				content: 'old pending',
				createdAt: TS,
				deliveryStatus: 'accepted',
			}],
		}));

		await load;

		expect(getChatMessagesMock).toHaveBeenCalledTimes(2);
		expect(chat.getCursor()).toEqual({ logId: 'new-log', lastAppendSeq: 1 });
		expect(messageContents(chat.chatMessages)).toEqual(['new']);
		expect(chat.pendingUserInputs.map((input) => input.clientRequestId)).toEqual(['req-new']);
	});

	it('reports generation-changed without installing a stale page when a buffered batch has a new logId', () => {
		const chat = new ChatState();
		const epoch = chat.beginSnapshotLoad();

		chat.applyEvents('new-log', [
			event(1, new AssistantMessage(TS, 'new'), { messageId: 'new-1' }),
		]);

		const result = chat.setFromPage({
			logId: 'old-log',
			events: [event(1, new UserMessage(TS, 'old'), { messageId: 'old-1' })],
			lastAppendSeq: 1,
			pageOldestSeq: 1,
			hasMore: false,
		}, epoch);

		expect(result).toBe('generation-changed');
		expect(chat.chatMessages).toEqual([]);
		expect(chat.getCursor()).toEqual({ logId: '', lastAppendSeq: 0 });
	});

	it('replaceGeneration clears pending overlays and resets the visible window', () => {
		const chat = new ChatState();
		chat.setPendingUserInputs([{
			chatId: 'chat-1',
			clientRequestId: 'req-1',
			content: 'old prompt',
			createdAt: TS,
			deliveryStatus: 'accepted',
		}]);
		chat.visibleMessageCount = 500;

		chat.replaceGeneration('new-log', [
			event(1, new AssistantMessage(TS, 'native'), { messageId: 'native-1' }),
		], { lastAppendSeq: 1, localNotice: 'The process died.' });

		expect(chat.visiblePendingInputs).toEqual([]);
		expect(chat.visibleMessageCount).toBe(INITIAL_VISIBLE_MESSAGES);
		expect(messageContents(chat.displayMessages)).toEqual([
			'native',
			'The process died.',
		]);
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
