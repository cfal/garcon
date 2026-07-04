import { describe, expect, it } from 'vitest';
import {
	getSidebarChatDragData,
	getSidebarChatDropTargetData,
	isSidebarChatDragData,
	isSidebarChatDropTargetData,
	resolveSidebarDropInstruction,
	sidebarDragCanReorder,
} from '../sidebar-pragmatic-dnd';
import type { DropTargetRecord } from '@atlaskit/pragmatic-drag-and-drop/types';
import type { SidebarChatDropTargetData } from '../sidebar-pragmatic-dnd';

function makeDropTarget(data: SidebarChatDropTargetData): DropTargetRecord {
	return {
		element: {} as Element,
		data: data as unknown as Record<string | symbol, unknown>,
		dropEffect: 'move',
		isActiveDueToStickiness: false,
	};
}

describe('sidebar pragmatic drag data', () => {
	it('accepts generated sidebar chat drag data', () => {
		const data = getSidebarChatDragData({
			chatId: 'chat-1',
			list: 'normal',
			index: 0,
			instanceId: Symbol('instance'),
			reorderScopeKey: 'normal:all',
		});

		expect(isSidebarChatDragData(data)).toBe(true);
		expect(isSidebarChatDropTargetData(data)).toBe(false);
	});

	it('accepts public string-keyed sidebar chat drag data records', () => {
		const instanceId = Symbol('instance');

		expect(
			isSidebarChatDragData({
				kind: 'sidebar-chat',
				splitPaneDragKind: 'split-pane-chat',
				chatId: 'chat-1',
				list: 'normal',
				index: 0,
				instanceId,
				reorderScopeKey: 'normal:all',
			}),
		).toBe(true);
	});

	it('accepts generated sidebar row drop target data', () => {
		const data = getSidebarChatDropTargetData({
			chatId: 'chat-2',
			list: 'normal',
			index: 1,
			instanceId: Symbol('instance'),
			reorderScopeKey: 'normal:all',
		});

		expect(isSidebarChatDropTargetData(data)).toBe(true);
		expect(isSidebarChatDragData(data)).toBe(false);
	});

	it('accepts public string-keyed sidebar row drop target data records', () => {
		const instanceId = Symbol('instance');

		expect(
			isSidebarChatDropTargetData({
				kind: 'sidebar-chat-row-target',
				chatId: 'chat-2',
				list: 'normal',
				index: 1,
				instanceId,
				reorderScopeKey: 'normal:all',
			}),
		).toBe(true);
	});

	it('rejects malformed values', () => {
		expect(isSidebarChatDragData(null)).toBe(false);
		expect(
			isSidebarChatDragData({
				kind: 'sidebar-chat',
				chatId: 'chat-1',
				list: 'normal',
				index: 0,
				instanceId: Symbol('instance'),
			}),
		).toBe(false);
		expect(isSidebarChatDropTargetData({ kind: 'sidebar-chat-row-target' })).toBe(false);
	});

	it('allows reorder only within the same instance and list', () => {
		const instanceId = Symbol('instance');
		const source = getSidebarChatDragData({
			chatId: 'chat-1',
			list: 'normal',
			index: 0,
			instanceId,
			reorderScopeKey: 'normal:all',
		});

		expect(
			sidebarDragCanReorder(
				source,
				getSidebarChatDropTargetData({
					chatId: 'chat-2',
					list: 'normal',
					index: 1,
					instanceId,
					reorderScopeKey: 'normal:all',
				}),
			),
		).toBe(true);

		expect(
			sidebarDragCanReorder(
				source,
				getSidebarChatDropTargetData({
					chatId: 'chat-2',
					list: 'pinned',
					index: 0,
					instanceId,
					reorderScopeKey: 'pinned:all',
				}),
			),
		).toBe(false);

		expect(
			sidebarDragCanReorder(
				source,
				getSidebarChatDropTargetData({
					chatId: 'chat-1',
					list: 'normal',
					index: 0,
					instanceId,
					reorderScopeKey: 'normal:all',
				}),
			),
		).toBe(false);
		expect(
			sidebarDragCanReorder(
				source,
				getSidebarChatDropTargetData({
					chatId: 'chat-2',
					list: 'normal',
					index: 1,
					instanceId,
					reorderScopeKey: 'normal:project:/tmp/other',
				}),
			),
		).toBe(false);
	});

	it('resolves a same-list row drop instruction', () => {
		const instanceId = Symbol('instance');
		const source = getSidebarChatDragData({
			chatId: 'chat-1',
			list: 'normal',
			index: 0,
			instanceId,
			reorderScopeKey: 'normal:all',
		});
		const targetData = getSidebarChatDropTargetData({
			chatId: 'chat-2',
			list: 'normal',
			index: 1,
			instanceId,
			reorderScopeKey: 'normal:all',
		});

		expect(resolveSidebarDropInstruction(source, [makeDropTarget(targetData)])).toEqual({
			sourceChatId: 'chat-1',
			sourceList: 'normal',
			sourceScopeKey: 'normal:all',
			targetChatId: 'chat-2',
			targetList: 'normal',
			closestEdge: null,
		});
	});

	it('rejects stale or incompatible row drop instructions', () => {
		const instanceId = Symbol('instance');
		const otherInstanceId = Symbol('other-instance');
		const source = getSidebarChatDragData({
			chatId: 'chat-1',
			list: 'normal',
			index: 0,
			instanceId,
			reorderScopeKey: 'normal:all',
		});

		expect(resolveSidebarDropInstruction(source, [])).toBeNull();
		expect(
			resolveSidebarDropInstruction(source, [
				makeDropTarget(
					getSidebarChatDropTargetData({
						chatId: 'chat-1',
						list: 'normal',
						index: 0,
						instanceId,
						reorderScopeKey: 'normal:all',
					}),
				),
			]),
		).toBeNull();
		expect(
			resolveSidebarDropInstruction(source, [
				makeDropTarget(
					getSidebarChatDropTargetData({
						chatId: 'chat-2',
						list: 'pinned',
						index: 0,
						instanceId,
						reorderScopeKey: 'pinned:all',
					}),
				),
			]),
		).toBeNull();
		expect(
			resolveSidebarDropInstruction(source, [
				makeDropTarget(
					getSidebarChatDropTargetData({
						chatId: 'chat-2',
						list: 'normal',
						index: 1,
						instanceId: otherInstanceId,
						reorderScopeKey: 'normal:all',
					}),
				),
			]),
		).toBeNull();
	});

	it('skips incompatible row records before resolving a compatible drop target', () => {
		const instanceId = Symbol('instance');
		const source = getSidebarChatDragData({
			chatId: 'chat-1',
			list: 'normal',
			index: 0,
			instanceId,
			reorderScopeKey: 'normal:all',
		});

		const selfTarget = getSidebarChatDropTargetData({
			chatId: 'chat-1',
			list: 'normal',
			index: 0,
			instanceId,
			reorderScopeKey: 'normal:all',
		});
		const compatibleTarget = getSidebarChatDropTargetData({
			chatId: 'chat-2',
			list: 'normal',
			index: 1,
			instanceId,
			reorderScopeKey: 'normal:all',
		});

		expect(
			resolveSidebarDropInstruction(source, [
				makeDropTarget(selfTarget),
				makeDropTarget(compatibleTarget),
			]),
		).toEqual({
			sourceChatId: 'chat-1',
			sourceList: 'normal',
			sourceScopeKey: 'normal:all',
			targetChatId: 'chat-2',
			targetList: 'normal',
			closestEdge: null,
		});
	});
});
