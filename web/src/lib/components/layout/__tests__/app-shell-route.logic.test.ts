import { describe, expect, it } from 'vitest';
import {
	isBareChatRoute,
	restoreChatIdForBareRoute,
	selectedChatIdFromRoute,
} from '../app-shell-route';

describe('selectedChatIdFromRoute', () => {
	it('identifies bare chat routes', () => {
		expect(isBareChatRoute('/')).toBe(true);
		expect(isBareChatRoute('/chat')).toBe(true);
		expect(isBareChatRoute('/chat/')).toBe(true);
		expect(isBareChatRoute('/chat/abc')).toBe(false);
		expect(isBareChatRoute('/login')).toBe(false);
	});

	it('clears the selected chat for bare chat routes', () => {
		expect(selectedChatIdFromRoute('/', undefined)).toBeNull();
		expect(selectedChatIdFromRoute('/chat', undefined)).toBeNull();
		expect(selectedChatIdFromRoute('/chat/', undefined)).toBeNull();
	});

	it('restores remembered chat only from loaded bare routes', () => {
		expect(
			restoreChatIdForBareRoute({
				pathname: '/',
				routeChatId: undefined,
				isLoadingChats: false,
				lastSelectedChatId: 'chat-1',
				selectedChatId: null,
			}),
		).toBe('chat-1');

		expect(
			restoreChatIdForBareRoute({
				pathname: '/',
				routeChatId: undefined,
				isLoadingChats: true,
				lastSelectedChatId: 'chat-1',
				selectedChatId: null,
			}),
		).toBeNull();

		expect(
			restoreChatIdForBareRoute({
				pathname: '/chat/chat-2',
				routeChatId: 'chat-2',
				isLoadingChats: false,
				lastSelectedChatId: 'chat-1',
				selectedChatId: null,
			}),
		).toBeNull();

		expect(
			restoreChatIdForBareRoute({
				pathname: '/',
				routeChatId: undefined,
				isLoadingChats: false,
				lastSelectedChatId: 'chat-1',
				selectedChatId: 'chat-1',
			}),
		).toBeNull();
	});
});
