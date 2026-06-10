import { describe, expect, it } from 'vitest';
import { SidebarChatReorderState, type SidebarChatOrderMap } from '../sidebar-chat-reorder-state.svelte';

function buildOrders(normal: string[]): SidebarChatOrderMap {
	return {
		pinned: [],
		normal,
		archived: [],
	};
}

describe('SidebarChatReorderState', () => {
	it('returns a window reorder request for unfiltered drags', () => {
		let visibleOrders = buildOrders(['a', 'b', 'c']);
		const reorder = new SidebarChatReorderState({
			get visibleOrders() { return visibleOrders; },
			get isFiltered() { return false; },
		});

		reorder.begin('normal', 'a');
		reorder.preview({
			list: 'normal',
			sourceChatId: 'a',
			targetChatId: 'c',
			closestEdge: 'bottom',
		});

		expect(reorder.orderFor('normal')).toEqual(['b', 'c', 'a']);
		expect(reorder.finish('normal')).toEqual({
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

		reorder.begin('normal', 'c');
		reorder.preview({
			list: 'normal',
			sourceChatId: 'c',
			targetChatId: 'a',
			closestEdge: 'top',
		});

		expect(reorder.finish('normal')).toEqual({
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

		reorder.begin('normal', 'c');
		reorder.preview({
			list: 'normal',
			sourceChatId: 'c',
			targetChatId: 'b',
			closestEdge: 'top',
		});

		expect(reorder.finish('normal')).toEqual({
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

		reorder.begin('normal', 'a');
		reorder.preview({
			list: 'normal',
			sourceChatId: 'a',
			targetChatId: 'c',
			closestEdge: 'bottom',
		});

		reorder.cancel('normal');
		expect(reorder.orderFor('normal')).toEqual(['a', 'b', 'c']);
		expect(reorder.finish('normal')).toBeNull();
	});

	it('rolls back only the matching optimistic order', () => {
		const visibleOrders = buildOrders(['a', 'b', 'c']);
		const reorder = new SidebarChatReorderState({
			get visibleOrders() { return visibleOrders; },
			get isFiltered() { return false; },
		});

		reorder.begin('normal', 'a');
		reorder.preview({
			list: 'normal',
			sourceChatId: 'a',
			targetChatId: 'c',
			closestEdge: 'bottom',
		});
		const request = reorder.finish('normal');

		expect(request?.kind).toBe('window');
		reorder.rollbackIfCurrent('normal', ['x', 'y', 'z']);
		expect(reorder.orderFor('normal')).toEqual(['b', 'c', 'a']);

		if (request?.kind === 'window') {
			reorder.rollbackIfCurrent('normal', request.newOrder);
		}
		expect(reorder.orderFor('normal')).toEqual(['a', 'b', 'c']);
	});

	it('uses the dragged chat id for filtered first-to-last moves', () => {
		const visibleOrders = buildOrders(['a', 'b', 'c']);
		const reorder = new SidebarChatReorderState({
			get visibleOrders() { return visibleOrders; },
			get isFiltered() { return true; },
		});

		reorder.begin('normal', 'a');
		reorder.preview({
			list: 'normal',
			sourceChatId: 'a',
			targetChatId: 'c',
			closestEdge: 'bottom',
		});

		expect(reorder.finish('normal')).toEqual({
			kind: 'relative',
			list: 'normal',
			chatId: 'a',
			target: { chatIdAbove: 'c' },
			visibleOrder: ['b', 'c', 'a'],
		});
	});

	it('returns a request for menu boundary moves', () => {
		const visibleOrders = buildOrders(['a', 'b', 'c']);
		const reorder = new SidebarChatReorderState({
			get visibleOrders() { return visibleOrders; },
			get isFiltered() { return false; },
		});

		expect(reorder.moveToBoundary({
			list: 'normal',
			chatId: 'c',
			boundary: 'start',
		})).toEqual({
			kind: 'window',
			list: 'normal',
			oldOrder: ['a', 'b', 'c'],
			newOrder: ['c', 'a', 'b'],
		});
	});
});
