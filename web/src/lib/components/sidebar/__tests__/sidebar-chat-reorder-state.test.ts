import { describe, expect, it } from 'vitest';
import { SidebarChatReorderState, type SidebarChatOrderMap } from '../sidebar-chat-reorder-state.svelte';
import type { DragEndLike } from '../drag-reorder';

function buildOrders(normal: string[]): SidebarChatOrderMap {
	return {
		pinned: [],
		normal,
		archived: [],
	};
}

function buildEvent(sourceId: string, sourceIndex: number, targetId: string, targetIndex: number): DragEndLike {
	return {
		canceled: false,
		operation: {
			source: { id: sourceId, index: sourceIndex, initialIndex: sourceIndex },
			target: { id: targetId, index: targetIndex },
		},
	};
}

describe('SidebarChatReorderState', () => {
	it('returns a window reorder request for unfiltered drags', () => {
		let visibleOrders = buildOrders(['a', 'b', 'c']);
		const reorder = new SidebarChatReorderState({
			get visibleOrders() { return visibleOrders; },
			get isFiltered() { return false; },
		});

		reorder.begin('normal');
		reorder.preview('normal', buildEvent('a', 0, 'c', 2));

		expect(reorder.orderFor('normal')).toEqual(['b', 'c', 'a']);
		expect(reorder.finish('normal', buildEvent('a', 0, 'c', 2))).toEqual({
			kind: 'window',
			list: 'normal',
			oldOrder: ['a', 'b', 'c'],
			newOrder: ['b', 'c', 'a'],
		});

		visibleOrders = buildOrders(['b', 'c', 'a']);
		reorder.reconcile();
		expect(reorder.orderFor('normal')).toEqual(['b', 'c', 'a']);
	});

	it('returns a relative target for filtered top drops', () => {
		const visibleOrders = buildOrders(['a', 'b', 'c']);
		const reorder = new SidebarChatReorderState({
			get visibleOrders() { return visibleOrders; },
			get isFiltered() { return true; },
		});

		reorder.begin('normal');
		reorder.preview('normal', buildEvent('c', 2, 'a', 0));

		expect(reorder.finish('normal', buildEvent('c', 2, 'a', 0))).toEqual({
			kind: 'relative',
			list: 'normal',
			chatId: 'c',
			target: { chatIdBelow: 'a' },
			visibleOrder: ['c', 'a', 'b'],
		});
	});

	it('returns a relative target for filtered middle drops', () => {
		const visibleOrders = buildOrders(['a', 'b', 'c']);
		const reorder = new SidebarChatReorderState({
			get visibleOrders() { return visibleOrders; },
			get isFiltered() { return true; },
		});

		reorder.begin('normal');
		reorder.preview('normal', buildEvent('c', 2, 'b', 1));

		expect(reorder.finish('normal', buildEvent('c', 2, 'b', 1))).toEqual({
			kind: 'relative',
			list: 'normal',
			chatId: 'c',
			target: { chatIdAbove: 'a' },
			visibleOrder: ['a', 'c', 'b'],
		});
	});

	it('restores visible order when a drag is canceled', () => {
		const visibleOrders = buildOrders(['a', 'b', 'c']);
		const reorder = new SidebarChatReorderState({
			get visibleOrders() { return visibleOrders; },
			get isFiltered() { return false; },
		});

		reorder.begin('normal');
		reorder.preview('normal', buildEvent('a', 0, 'c', 2));

		expect(reorder.finish('normal', {
			...buildEvent('a', 0, 'c', 2),
			canceled: true,
		})).toBeNull();
		expect(reorder.orderFor('normal')).toEqual(['a', 'b', 'c']);
	});

	it('rolls back only the matching optimistic order', () => {
		const visibleOrders = buildOrders(['a', 'b', 'c']);
		const reorder = new SidebarChatReorderState({
			get visibleOrders() { return visibleOrders; },
			get isFiltered() { return false; },
		});

		reorder.begin('normal');
		reorder.preview('normal', buildEvent('a', 0, 'c', 2));
		const request = reorder.finish('normal', buildEvent('a', 0, 'c', 2));

		expect(request?.kind).toBe('window');
		reorder.rollbackIfCurrent('normal', ['x', 'y', 'z']);
		expect(reorder.orderFor('normal')).toEqual(['b', 'c', 'a']);

		if (request?.kind === 'window') {
			reorder.rollbackIfCurrent('normal', request.newOrder);
		}
		expect(reorder.orderFor('normal')).toEqual(['a', 'b', 'c']);
	});
});
