import { describe, expect, it } from 'vitest';
import {
	getSidebarChatDragData,
	getSidebarChatDropTargetData,
	isSidebarChatDragData,
	isSidebarChatDropTargetData,
	sidebarDragCanReorder,
} from '../sidebar-pragmatic-dnd';

describe('sidebar pragmatic drag data', () => {
	it('accepts generated sidebar chat drag data', () => {
		const data = getSidebarChatDragData({
			chatId: 'chat-1',
			list: 'normal',
			index: 0,
			instanceId: Symbol('instance'),
		});

		expect(isSidebarChatDragData(data)).toBe(true);
		expect(isSidebarChatDropTargetData(data)).toBe(false);
	});

	it('accepts generated sidebar row drop target data', () => {
		const data = getSidebarChatDropTargetData({
			chatId: 'chat-2',
			list: 'normal',
			index: 1,
			instanceId: Symbol('instance'),
		});

		expect(isSidebarChatDropTargetData(data)).toBe(true);
		expect(isSidebarChatDragData(data)).toBe(false);
	});

	it('rejects malformed values', () => {
		expect(isSidebarChatDragData(null)).toBe(false);
		expect(isSidebarChatDropTargetData({ kind: 'sidebar-chat-row-target' })).toBe(false);
	});

	it('allows reorder only within the same instance and list', () => {
		const instanceId = Symbol('instance');
		const source = getSidebarChatDragData({
			chatId: 'chat-1',
			list: 'normal',
			index: 0,
			instanceId,
		});

		expect(sidebarDragCanReorder(source, getSidebarChatDropTargetData({
			chatId: 'chat-2',
			list: 'normal',
			index: 1,
			instanceId,
		}))).toBe(true);

		expect(sidebarDragCanReorder(source, getSidebarChatDropTargetData({
			chatId: 'chat-2',
			list: 'pinned',
			index: 0,
			instanceId,
		}))).toBe(false);

		expect(sidebarDragCanReorder(source, getSidebarChatDropTargetData({
			chatId: 'chat-1',
			list: 'normal',
			index: 0,
			instanceId,
		}))).toBe(false);
	});
});
