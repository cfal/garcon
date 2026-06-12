// Unit tests for ChatState class. Tests synchronous state management
// only; async loadMessages relies on network APIs and is not tested here.

import { describe, it, expect } from 'vitest';
import { ChatState } from '../state.svelte';
import { UserMessage, AssistantMessage, ErrorMessage } from '$shared/chat-types';

describe('ChatState', () => {
	it('starts with empty messages', () => {
		const state = new ChatState();
		expect(state.chatMessages).toEqual([]);
		expect(state.isLoadingMessages).toBe(false);
		expect(state.hasMoreMessages).toBe(false);
		expect(state.totalMessages).toBe(0);
		expect(state.isUserScrolledUp).toBe(false);
	});

	it('setMessages replaces the message array', () => {
		const state = new ChatState();
		const msgs = [new UserMessage('2024-01-01T00:00:00Z', 'hello')];
		state.setMessages(msgs);
		expect(state.chatMessages).toEqual(msgs);
	});

	it('appendMessages adds to the end', () => {
		const state = new ChatState();
		state.setMessages([new UserMessage('2024-01-01T00:00:00Z', 'first')]);
		state.appendMessages([new AssistantMessage('2024-01-01T00:00:01Z', 'second')]);
		expect(state.chatMessages).toHaveLength(2);
		expect((state.chatMessages[1] as AssistantMessage).content).toBe('second');
	});

	it('appendMessagesByIdentity deduplicates across batches', () => {
		const state = new ChatState();
		const first = new UserMessage('2024-01-01T00:00:00Z', 'hello', undefined, {
			clientRequestId: 'req-1',
		});
		const duplicate = new UserMessage('2024-01-01T00:00:01Z', 'hello again', undefined, {
			clientRequestId: 'req-1',
		});
		const assistant = new AssistantMessage('2024-01-01T00:00:02Z', 'response');

		state.appendMessagesByIdentity([first]);
		state.appendMessagesByIdentity([duplicate, assistant]);

		expect(state.chatMessages).toEqual([first, assistant]);
	});

	it('resetForNewChat clears identity tokens for the next chat', () => {
		const state = new ChatState();
		state.appendMessagesByIdentity([
			new UserMessage('2024-01-01T00:00:00Z', 'old chat', undefined, {
				clientRequestId: 'req-1',
			}),
		]);

		state.resetForNewChat();
		state.appendMessagesByIdentity([
			new UserMessage('2024-01-01T00:00:00Z', 'new chat', undefined, {
				clientRequestId: 'req-1',
			}),
		]);

		expect(state.chatMessages).toHaveLength(1);
		expect((state.chatMessages[0] as UserMessage).content).toBe('new chat');
	});

	it('setMessages rebuilds identity tokens for replacement transcripts', () => {
		const state = new ChatState();
		state.setMessages([
			new UserMessage('2024-01-01T00:00:00Z', 'loaded', undefined, {
				clientRequestId: 'req-1',
			}),
		]);

		state.appendMessagesByIdentity([
			new UserMessage('2024-01-01T00:00:01Z', 'duplicate echo', undefined, {
				clientRequestId: 'req-1',
			}),
		]);

		expect(state.chatMessages).toHaveLength(1);
		expect((state.chatMessages[0] as UserMessage).content).toBe('loaded');
	});

	it('appendErrorMessage adds an error row', () => {
		const state = new ChatState();

		state.appendErrorMessage('Failed to send message');

		expect(state.chatMessages).toHaveLength(1);
		expect(state.chatMessages[0]).toBeInstanceOf(ErrorMessage);
		expect((state.chatMessages[0] as ErrorMessage).content).toBe('Failed to send message');
	});

	it('clearMessages resets all state', () => {
		const state = new ChatState();
		state.setMessages([new UserMessage('2024-01-01T00:00:00Z', 'test')]);
		state.hasMoreMessages = true;
		state.totalMessages = 5;

		state.clearMessages();

		expect(state.chatMessages).toEqual([]);
		expect(state.hasMoreMessages).toBe(false);
		expect(state.totalMessages).toBe(0);
	});

	it('resetForNewChat clears messages and resets selection state', () => {
		const state = new ChatState();
		state.setMessages([new UserMessage('2024-01-01T00:00:00Z', 'old')]);
		state.isUserScrolledUp = true;
		state.hasMoreMessages = true;
		state.totalMessages = 50;

		state.resetForNewChat();

		expect(state.chatMessages).toEqual([]);
		expect(state.isUserScrolledUp).toBe(false);
		expect(state.hasMoreMessages).toBe(false);
		expect(state.totalMessages).toBe(0);
	});

	it('loadEarlierMessages increases visible count by 100', () => {
		const state = new ChatState();
		const initial = state.visibleMessageCount;
		state.loadEarlierMessages();
		expect(state.visibleMessageCount).toBe(initial + 100);
	});

	it('visibleMessages returns full array when under limit', () => {
		const state = new ChatState();
		const msgs = [
			new UserMessage('2024-01-01T00:00:00Z', 'a'),
			new UserMessage('2024-01-01T00:00:01Z', 'b'),
		];
		state.setMessages(msgs);
		expect(state.visibleMessages).toEqual(msgs);
	});

	it('displayMessages reuses chatMessages when there are no pending inputs', () => {
		const state = new ChatState();
		const msgs = [
			new UserMessage('2024-01-01T00:00:00Z', 'a'),
			new AssistantMessage('2024-01-01T00:00:01Z', 'b'),
		];

		state.setMessages(msgs);

		expect(state.displayMessages).toBe(state.chatMessages);
	});

	it('displayMessages merges sorted pending inputs without resorting durable messages', () => {
		const state = new ChatState();
		state.setMessages([
			new AssistantMessage('2024-01-01T00:00:01Z', 'server 1'),
			new AssistantMessage('2024-01-01T00:00:03Z', 'server 3'),
		]);

		state.setPendingUserInputs([
			{
				chatId: 'chat-1',
				clientRequestId: 'req-2',
				clientMessageId: 'msg-2',
				content: 'pending 2',
				createdAt: '2024-01-01T00:00:02Z',
				deliveryStatus: 'submitting',
			},
			{
				chatId: 'chat-1',
				clientRequestId: 'req-0',
				clientMessageId: 'msg-0',
				content: 'pending 0',
				createdAt: '2024-01-01T00:00:00Z',
				deliveryStatus: 'submitting',
			},
		]);

		expect(state.displayMessages.map((message) => ('content' in message ? message.content : ''))).toEqual([
			'pending 0',
			'server 1',
			'pending 2',
			'server 3',
		]);
	});

	it('displayMessages places pending inputs before durable messages with matching timestamps', () => {
		const state = new ChatState();
		state.setMessages([new AssistantMessage('2024-01-01T00:00:01Z', 'server')]);
		state.setPendingUserInputs([
			{
				chatId: 'chat-1',
				clientRequestId: 'req-1',
				clientMessageId: 'msg-1',
				content: 'pending',
				createdAt: '2024-01-01T00:00:01Z',
				deliveryStatus: 'submitting',
			},
		]);

		expect(state.displayMessages.map((message) => ('content' in message ? message.content : ''))).toEqual([
			'pending',
			'server',
		]);
	});

	it('memoizes display and visible messages between state writes', () => {
		const state = new ChatState();
		state.setMessages([
			new UserMessage('2024-01-01T00:00:00Z', 'a'),
			new AssistantMessage('2024-01-01T00:00:01Z', 'b'),
		]);

		const displayBefore = state.displayMessages;
		const visibleBefore = state.visibleMessages;

		expect(state.displayMessages).toBe(displayBefore);
		expect(state.visibleMessages).toBe(visibleBefore);

		state.appendMessages([new AssistantMessage('2024-01-01T00:00:02Z', 'c')]);

		expect(state.displayMessages).not.toBe(displayBefore);
		expect(state.visibleMessages).not.toBe(visibleBefore);
	});

	it('visibleMessages slices to tail when over limit', () => {
		const state = new ChatState();
		state.visibleMessageCount = 1;
		const msgs = [
			new UserMessage('2024-01-01T00:00:00Z', 'a'),
			new UserMessage('2024-01-01T00:00:01Z', 'b'),
		];
		state.setMessages(msgs);
		expect(state.visibleMessages).toHaveLength(1);
		expect((state.visibleMessages[0] as UserMessage).content).toBe('b');
	});

	it('persistMessages overwrites cached content for same-length replacements', () => {
		const chatId = 'persist-chat';
		localStorage.clear();
		const chatState = new ChatState();
		chatState.setMessages([new UserMessage('2024-01-01T00:00:00Z', 'first')]);
		chatState.persistMessages(chatId);

		chatState.setMessages([new UserMessage('2024-01-01T00:00:01Z', 'second')]);
		chatState.persistMessages(chatId);

		const restored = new ChatState();
		const result = restored.restoreMessages(chatId);
		expect(result).toEqual({ count: 1, stale: false });
		expect(restored.chatMessages).toHaveLength(1);
		expect((restored.chatMessages[0] as UserMessage).content).toBe('second');
		localStorage.clear();
	});

	it('persistMessages stores only the initial visible message window', () => {
		const chatId = 'window-chat';
		localStorage.clear();
		const chatState = new ChatState();
		chatState.setMessages(
			Array.from(
				{ length: 105 },
				(_, index) => new UserMessage('2024-01-01T00:00:00Z', `message-${index}`),
			),
		);

		chatState.persistMessages(chatId);

		const restored = new ChatState();
		const result = restored.restoreMessages(chatId);
		expect(result?.count).toBe(100);
		expect((restored.chatMessages[0] as UserMessage).content).toBe('message-5');
		localStorage.clear();
	});

	it('removeCachedMessages delegates to snapshot cache', () => {
		const chatId = 'remove-chat';
		localStorage.clear();
		const chatState = new ChatState();
		chatState.setMessages([new UserMessage('2024-01-01T00:00:00Z', 'hello')]);
		chatState.persistMessages(chatId);

		chatState.removeCachedMessages(chatId);

		const restored = new ChatState();
		expect(restored.restoreMessages(chatId)).toBeNull();
		localStorage.clear();
	});
});
