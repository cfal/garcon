// Unit tests for ChatState class. Tests synchronous state management
// only; async loadMessages relies on network APIs and is not tested here.

import { describe, it, expect } from 'vitest';
import { ChatState } from '../state.svelte';
import { UserMessage, AssistantMessage } from '$shared/chat-types';

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
		const msgs = [
			new UserMessage('2024-01-01T00:00:00Z', 'hello'),
		];
		state.setMessages(msgs);
		expect(state.chatMessages).toEqual(msgs);
	});

	it('appendMessages adds to the end', () => {
		const state = new ChatState();
		state.setMessages([
			new UserMessage('2024-01-01T00:00:00Z', 'first'),
		]);
		state.appendMessages([
			new AssistantMessage('2024-01-01T00:00:01Z', 'second'),
		]);
		expect(state.chatMessages).toHaveLength(2);
		expect((state.chatMessages[1] as AssistantMessage).content).toBe('second');
	});

	it('clearMessages resets all state', () => {
		const state = new ChatState();
		state.setMessages([
			new UserMessage('2024-01-01T00:00:00Z', 'test'),
		]);
		state.hasMoreMessages = true;
		state.totalMessages = 5;

		state.clearMessages();

		expect(state.chatMessages).toEqual([]);
		expect(state.hasMoreMessages).toBe(false);
		expect(state.totalMessages).toBe(0);
	});

	it('resetForNewChat clears messages and resets selection state', () => {
		const state = new ChatState();
		state.setMessages([
			new UserMessage('2024-01-01T00:00:00Z', 'old'),
		]);
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
		localStorage.removeItem(`chat_messages_${chatId}`);
		const state = new ChatState();
		state.setMessages([
			new UserMessage('2024-01-01T00:00:00Z', 'first'),
		]);
		state.persistMessages(chatId);

		state.setMessages([
			new UserMessage('2024-01-01T00:00:01Z', 'second'),
		]);
		state.persistMessages(chatId);

		const restored = new ChatState();
		const ok = restored.restoreMessages(chatId);
		expect(ok).toBe(true);
		expect(restored.chatMessages).toHaveLength(1);
		expect((restored.chatMessages[0] as UserMessage).content).toBe('second');
		localStorage.removeItem(`chat_messages_${chatId}`);
	});
});
