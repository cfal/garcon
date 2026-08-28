import { describe, expect, it } from 'vitest';
import {
	DEFAULT_CHAT_LIST_DOCK,
	chatListDividerEdge,
	normalizeChatListDock,
} from '../desktop-layout';

describe('desktop layout', () => {
	it('defaults to a left-docked chat list', () => {
		expect(DEFAULT_CHAT_LIST_DOCK).toBe('left');
		expect(normalizeChatListDock(undefined)).toBe('left');
		expect(normalizeChatListDock(null)).toBe('left');
		expect(normalizeChatListDock('middle')).toBe('left');
	});

	it('accepts explicit dock sides', () => {
		expect(normalizeChatListDock('left')).toBe('left');
		expect(normalizeChatListDock('right')).toBe('right');
	});

	it('derives the dock side from the legacy three-pane order', () => {
		expect(normalizeChatListDock(['chat-list', 'main', 'workspace-sidebar'])).toBe('left');
		expect(normalizeChatListDock(['workspace-sidebar', 'main', 'chat-list'])).toBe('right');
		expect(normalizeChatListDock(['main', 'workspace-sidebar', 'chat-list'])).toBe('right');
		expect(normalizeChatListDock(['chat-list', 'workspace-sidebar', 'main'])).toBe('left');
	});

	it('falls back for malformed legacy orders', () => {
		expect(normalizeChatListDock(['chat-list', 'main'])).toBe('left');
		expect(normalizeChatListDock(['chat-list', 'main', 'unknown'])).toBe('left');
		expect(normalizeChatListDock(['workspace-sidebar', 'unknown', 'chat-list'])).toBe('left');
		expect(normalizeChatListDock([42, 'main', 'chat-list'])).toBe('left');
		expect(normalizeChatListDock(['main', 'chat-list', 'chat-list'])).toBe('left');
	});

	it('resolves the divider edge from the dock side', () => {
		expect(chatListDividerEdge('left')).toBe('end');
		expect(chatListDividerEdge('right')).toBe('start');
	});
});
