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

	it('resolves the divider edge from the dock side', () => {
		expect(chatListDividerEdge('left')).toBe('end');
		expect(chatListDividerEdge('right')).toBe('start');
	});
});
