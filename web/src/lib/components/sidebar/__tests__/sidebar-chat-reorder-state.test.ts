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
	it('returns a relative reorder request for unfiltered drags', () => {
		let visibleOrders = buildOrders(['a', 'b', 'c']);
		const reorder = new SidebarChatReorderState({
			get visibleOrders() { return visibleOrders; },
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
				kind: 'relative',
				list: 'normal',
				chatId: 'a',
				target: { chatIdAbove: 'c' },
				visibleOrder: ['b', 'c', 'a'],
				sequence: 1,
			});

		visibleOrders = buildOrders(['b', 'c', 'a']);
		reorder.reconcile();
		expect(reorder.orderFor('normal')).toEqual(['b', 'c', 'a']);
	});

	it('returns a relative target for filtered top drops', () => {
		const visibleOrders = buildOrders(['a', 'b', 'c']);
		const reorder = new SidebarChatReorderState({
			get visibleOrders() { return visibleOrders; },
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
				sequence: 1,
			});
	});

	it('returns a relative target for filtered middle drops', () => {
		const visibleOrders = buildOrders(['a', 'b', 'c']);
		const reorder = new SidebarChatReorderState({
			get visibleOrders() { return visibleOrders; },
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
				sequence: 1,
				});
	});

	it('keeps repeated drag previews idempotent for adjacent swaps', () => {
		const visibleOrders = buildOrders(['a', 'b', 'c']);
		const reorder = new SidebarChatReorderState({
			get visibleOrders() { return visibleOrders; },
		});

		reorder.begin('normal', 'a');
		reorder.preview({
			list: 'normal',
			sourceChatId: 'a',
			targetChatId: 'b',
			closestEdge: 'bottom',
		});
		expect(reorder.orderFor('normal')).toEqual(['b', 'a', 'c']);

		reorder.preview({
			list: 'normal',
			sourceChatId: 'a',
			targetChatId: 'b',
			closestEdge: 'bottom',
		});

		expect(reorder.orderFor('normal')).toEqual(['b', 'a', 'c']);
		expect(reorder.finish('normal')).toEqual({
			kind: 'relative',
			list: 'normal',
			chatId: 'a',
			target: { chatIdAbove: 'b' },
			visibleOrder: ['b', 'a', 'c'],
			sequence: 1,
		});
	});

	it('restores the drag-start order when an adjacent drag returns to its original edge', () => {
		const visibleOrders = buildOrders(['a', 'b', 'c']);
		const reorder = new SidebarChatReorderState({
			get visibleOrders() { return visibleOrders; },
		});

		reorder.begin('normal', 'a');
		reorder.preview({
			list: 'normal',
			sourceChatId: 'a',
			targetChatId: 'b',
			closestEdge: 'bottom',
		});
		expect(reorder.orderFor('normal')).toEqual(['b', 'a', 'c']);

		reorder.preview({
			list: 'normal',
			sourceChatId: 'a',
			targetChatId: 'b',
			closestEdge: 'top',
		});

		expect(reorder.orderFor('normal')).toEqual(['a', 'b', 'c']);
		expect(reorder.finish('normal')).toBeNull();
	});

	it('restores visible order when a drag is canceled', () => {
		const visibleOrders = buildOrders(['a', 'b', 'c']);
		const reorder = new SidebarChatReorderState({
			get visibleOrders() { return visibleOrders; },
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

	it('keeps the active drag alive when initial order reconciliation runs', () => {
		const visibleOrders = buildOrders(['a', 'b', 'c']);
		const reorder = new SidebarChatReorderState({
			get visibleOrders() { return visibleOrders; },
		});

		reorder.begin('normal', 'a');
		reorder.reconcile();
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
				sequence: 1,
			});
	});

	it('starts a second drag from the current optimistic order', () => {
		const visibleOrders = buildOrders(['a', 'b', 'c', 'd']);
		const reorder = new SidebarChatReorderState({
			get visibleOrders() { return visibleOrders; },
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
					visibleOrder: ['b', 'c', 'a', 'd'],
					sequence: 1,
				});

		reorder.begin('normal', 'b');
		reorder.preview({
			list: 'normal',
			sourceChatId: 'b',
			targetChatId: 'a',
			closestEdge: 'bottom',
		});

				expect(reorder.finish('normal')).toEqual({
					kind: 'relative',
					list: 'normal',
					chatId: 'b',
					target: { chatIdAbove: 'a' },
					visibleOrder: ['c', 'a', 'b', 'd'],
					sequence: 2,
				});
	});

	it('rolls back only the matching optimistic order', () => {
		const visibleOrders = buildOrders(['a', 'b', 'c']);
		const reorder = new SidebarChatReorderState({
			get visibleOrders() { return visibleOrders; },
		});

		reorder.begin('normal', 'a');
		reorder.preview({
			list: 'normal',
			sourceChatId: 'a',
			targetChatId: 'c',
			closestEdge: 'bottom',
		});
		const request = reorder.finish('normal');

		expect(request?.kind).toBe('relative');
		reorder.rollbackIfCurrent('normal', (request?.sequence ?? 0) + 1, ['x', 'y', 'z']);
		expect(reorder.orderFor('normal')).toEqual(['b', 'c', 'a']);

		if (request?.kind === 'relative') {
			reorder.rollbackIfCurrent('normal', request.sequence, request.visibleOrder);
		}
		expect(reorder.orderFor('normal')).toEqual(['a', 'b', 'c']);
	});

	it('keeps pending optimistic order through stale refreshes', () => {
		let visibleOrders = buildOrders(['a', 'b', 'c']);
		const reorder = new SidebarChatReorderState({
			get visibleOrders() { return visibleOrders; },
		});

		reorder.begin('normal', 'a');
		reorder.preview({
			list: 'normal',
			sourceChatId: 'a',
			targetChatId: 'b',
			closestEdge: 'bottom',
		});
		const request = reorder.finish('normal');
		expect(request).toEqual({
			kind: 'relative',
			list: 'normal',
			chatId: 'a',
			target: { chatIdAbove: 'b' },
			visibleOrder: ['b', 'a', 'c'],
			sequence: 1,
		});

		visibleOrders = buildOrders(['b', 'a', 'c']);
		reorder.reconcile();
		expect(reorder.orderFor('normal')).toEqual(['b', 'a', 'c']);

		visibleOrders = buildOrders(['a', 'b', 'c']);
		reorder.reconcile();
		expect(reorder.orderFor('normal')).toEqual(['b', 'a', 'c']);

		reorder.completeIfCurrent('normal', request!.sequence);
		visibleOrders = buildOrders(['b', 'a', 'c']);
		reorder.reconcile();
		expect(reorder.orderFor('normal')).toEqual(['b', 'a', 'c']);
	});

	it('uses the dragged chat id for filtered first-to-last moves', () => {
		const visibleOrders = buildOrders(['a', 'b', 'c']);
		const reorder = new SidebarChatReorderState({
			get visibleOrders() { return visibleOrders; },
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
			sequence: 1,
		});
	});

	it('returns a request for menu boundary moves', () => {
		const visibleOrders = buildOrders(['a', 'b', 'c']);
		const reorder = new SidebarChatReorderState({
			get visibleOrders() { return visibleOrders; },
		});

		expect(reorder.moveToBoundary({
			list: 'normal',
			chatId: 'c',
			boundary: 'start',
			})).toEqual({
				kind: 'relative',
				list: 'normal',
					chatId: 'c',
					target: { chatIdBelow: 'a' },
					visibleOrder: ['c', 'a', 'b'],
					sequence: 1,
				});
	});
});
