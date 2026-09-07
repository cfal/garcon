import { describe, expect, it } from 'vitest';
import {
	SidebarChatReorderState,
	type SidebarChatOrderMap,
} from '../sidebar-chat-reorder-state.svelte';

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
			get visibleOrders() {
				return visibleOrders;
			},
		});
		expect(reorder.hasOverrides).toBe(false);

		reorder.begin('normal', 'a');
		expect(reorder.hasOverrides).toBe(true);
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
			placement: { kind: 'relative', referenceChatId: 'c', position: 'after' },
			visibleOrder: ['b', 'c', 'a'],
			sequence: 1,
		});

		visibleOrders = buildOrders(['b', 'c', 'a']);
		reorder.reconcile();
		expect(reorder.orderFor('normal')).toEqual(['b', 'c', 'a']);
		expect(reorder.hasOverrides).toBe(true);
		reorder.completeIfCurrent('normal', 1);
		expect(reorder.hasOverrides).toBe(false);
	});

	it('returns a relative target for filtered top drops', () => {
		const visibleOrders = buildOrders(['a', 'b', 'c']);
		const reorder = new SidebarChatReorderState({
			get visibleOrders() {
				return visibleOrders;
			},
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
			placement: { kind: 'relative', referenceChatId: 'a', position: 'before' },
			visibleOrder: ['c', 'a', 'b'],
			sequence: 1,
		});
	});

	it('returns a relative target for filtered middle drops', () => {
		const visibleOrders = buildOrders(['a', 'b', 'c']);
		const reorder = new SidebarChatReorderState({
			get visibleOrders() {
				return visibleOrders;
			},
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
			placement: { kind: 'relative', referenceChatId: 'a', position: 'after' },
			visibleOrder: ['a', 'c', 'b'],
			sequence: 1,
		});
	});

	it('keeps repeated drag previews idempotent for adjacent swaps', () => {
		const visibleOrders = buildOrders(['a', 'b', 'c']);
		const reorder = new SidebarChatReorderState({
			get visibleOrders() {
				return visibleOrders;
			},
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
			placement: { kind: 'relative', referenceChatId: 'b', position: 'after' },
			visibleOrder: ['b', 'a', 'c'],
			sequence: 1,
		});
	});

	it('restores the drag-start order when an adjacent drag returns to its original edge', () => {
		const visibleOrders = buildOrders(['a', 'b', 'c']);
		const reorder = new SidebarChatReorderState({
			get visibleOrders() {
				return visibleOrders;
			},
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
			get visibleOrders() {
				return visibleOrders;
			},
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
			get visibleOrders() {
				return visibleOrders;
			},
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
			placement: { kind: 'relative', referenceChatId: 'c', position: 'after' },
			visibleOrder: ['b', 'c', 'a'],
			sequence: 1,
		});
	});

	it('starts a second drag from the current optimistic order', () => {
		const visibleOrders = buildOrders(['a', 'b', 'c', 'd']);
		const reorder = new SidebarChatReorderState({
			get visibleOrders() {
				return visibleOrders;
			},
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
			placement: { kind: 'relative', referenceChatId: 'c', position: 'after' },
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
			placement: { kind: 'relative', referenceChatId: 'a', position: 'after' },
			visibleOrder: ['c', 'a', 'b', 'd'],
			sequence: 2,
		});
	});

	it('ignores an older completion while a newer optimistic move is pending', () => {
		let visibleOrders = buildOrders(['a', 'b', 'c', 'd']);
		const reorder = new SidebarChatReorderState({
			get visibleOrders() {
				return visibleOrders;
			},
		});

		reorder.begin('normal', 'a');
		reorder.preview({
			list: 'normal',
			sourceChatId: 'a',
			targetChatId: 'c',
			closestEdge: 'bottom',
		});
		const first = reorder.finish('normal');
		reorder.begin('normal', 'b');
		reorder.preview({
			list: 'normal',
			sourceChatId: 'b',
			targetChatId: 'a',
			closestEdge: 'bottom',
		});
		const second = reorder.finish('normal');

		if (!first || !second) throw new Error('expected optimistic reorder requests');
		visibleOrders = buildOrders(first.visibleOrder);
		reorder.reconcile();
		reorder.completeIfCurrent('normal', first.sequence);
		expect(reorder.orderFor('normal')).toEqual(second.visibleOrder);

		visibleOrders = buildOrders(second.visibleOrder);
		reorder.completeIfCurrent('normal', second.sequence);
		expect(reorder.orderFor('normal')).toEqual(second.visibleOrder);
	});

	it('retires an older completion without cancelling an active drag', () => {
		const visibleOrders = buildOrders(['a', 'b', 'c', 'd']);
		const reorder = new SidebarChatReorderState({
			get visibleOrders() {
				return visibleOrders;
			},
		});

		reorder.begin('normal', 'a');
		reorder.preview({
			list: 'normal',
			sourceChatId: 'a',
			targetChatId: 'c',
			closestEdge: 'bottom',
		});
		const first = reorder.finish('normal');
		if (!first) throw new Error('expected first optimistic reorder request');

		reorder.begin('normal', 'b');
		reorder.preview({
			list: 'normal',
			sourceChatId: 'b',
			targetChatId: 'a',
			closestEdge: 'bottom',
		});
		reorder.completeIfCurrent('normal', first.sequence);

		expect(reorder.activeList).toBe('normal');
		expect(reorder.activeChatId).toBe('b');
		expect(reorder.orderFor('normal')).toEqual(['c', 'a', 'b', 'd']);
		expect(reorder.finish('normal')).toMatchObject({
			chatId: 'b',
			placement: { kind: 'relative', referenceChatId: 'a', position: 'after' },
		});
	});

	it('retires an older rollback without cancelling an active drag', () => {
		const visibleOrders = buildOrders(['a', 'b', 'c', 'd']);
		const reorder = new SidebarChatReorderState({
			get visibleOrders() {
				return visibleOrders;
			},
		});

		reorder.begin('normal', 'a');
		reorder.preview({
			list: 'normal',
			sourceChatId: 'a',
			targetChatId: 'c',
			closestEdge: 'bottom',
		});
		const first = reorder.finish('normal');
		if (!first) throw new Error('expected first optimistic reorder request');

		reorder.begin('normal', 'b');
		reorder.preview({
			list: 'normal',
			sourceChatId: 'b',
			targetChatId: 'a',
			closestEdge: 'bottom',
		});
		reorder.rollbackIfCurrent('normal', first.sequence, first.visibleOrder);

		expect(reorder.activeList).toBe('normal');
		expect(reorder.activeChatId).toBe('b');
		expect(reorder.orderFor('normal')).toEqual(['c', 'a', 'b', 'd']);
		expect(reorder.finish('normal')).toMatchObject({
			chatId: 'b',
			placement: { kind: 'relative', referenceChatId: 'a', position: 'after' },
		});
	});

	it('rolls back only the matching optimistic order', () => {
		const visibleOrders = buildOrders(['a', 'b', 'c']);
		const reorder = new SidebarChatReorderState({
			get visibleOrders() {
				return visibleOrders;
			},
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
			get visibleOrders() {
				return visibleOrders;
			},
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
			placement: { kind: 'relative', referenceChatId: 'b', position: 'after' },
			visibleOrder: ['b', 'a', 'c'],
			sequence: 1,
		});

		visibleOrders = buildOrders(['b', 'a', 'c']);
		reorder.reconcile();
		expect(reorder.orderFor('normal')).toEqual(['b', 'a', 'c']);

		visibleOrders = buildOrders(['a', 'b', 'c']);
		reorder.reconcile();
		expect(reorder.orderFor('normal')).toEqual(['b', 'a', 'c']);

		visibleOrders = buildOrders(['c', 'b', 'a']);
		reorder.completeIfCurrent('normal', request!.sequence);
		expect(reorder.orderFor('normal')).toEqual(['c', 'b', 'a']);
	});

	it('uses the dragged chat id for filtered first-to-last moves', () => {
		const visibleOrders = buildOrders(['a', 'b', 'c']);
		const reorder = new SidebarChatReorderState({
			get visibleOrders() {
				return visibleOrders;
			},
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
			placement: { kind: 'relative', referenceChatId: 'c', position: 'after' },
			visibleOrder: ['b', 'c', 'a'],
			sequence: 1,
		});
	});

	it('returns a request for menu boundary moves', () => {
		const visibleOrders = buildOrders(['a', 'b', 'c']);
		const reorder = new SidebarChatReorderState({
			get visibleOrders() {
				return visibleOrders;
			},
		});

		expect(
			reorder.moveToBoundary({
				list: 'normal',
				chatId: 'c',
				boundary: 'start',
			}),
		).toEqual({
			kind: 'relative',
			list: 'normal',
			chatId: 'c',
			placement: { kind: 'relative', referenceChatId: 'a', position: 'before' },
			visibleOrder: ['c', 'a', 'b'],
			sequence: 1,
		});
	});

	it('resolves grouped drag moves against the active project scope', () => {
		const visibleOrders = buildOrders(['p1-a', 'p1-b', 'p2-a', 'p2-b']);
		const reorder = new SidebarChatReorderState({
			get visibleOrders() {
				return visibleOrders;
			},
		});

		reorder.begin('normal', 'p2-b', { ids: ['p2-a', 'p2-b'] });
		reorder.preview({
			list: 'normal',
			sourceChatId: 'p2-b',
			targetChatId: 'p2-a',
			closestEdge: 'top',
		});

		expect(reorder.finish('normal')).toEqual({
			kind: 'relative',
			list: 'normal',
			chatId: 'p2-b',
			placement: { kind: 'relative', referenceChatId: 'p2-a', position: 'before' },
			visibleOrder: ['p1-a', 'p1-b', 'p2-b', 'p2-a'],
			sequence: 1,
		});
	});

	it('resolves scoped bottom moves against same-project anchors', () => {
		const visibleOrders = buildOrders(['p1-a', 'p2-a', 'p2-b', 'p1-b']);
		const reorder = new SidebarChatReorderState({
			get visibleOrders() {
				return visibleOrders;
			},
		});

		reorder.begin('normal', 'p2-a', { ids: ['p2-a', 'p2-b'] });
		reorder.preview({
			list: 'normal',
			sourceChatId: 'p2-a',
			targetChatId: 'p2-b',
			closestEdge: 'bottom',
		});

		expect(reorder.finish('normal')).toEqual({
			kind: 'relative',
			list: 'normal',
			chatId: 'p2-a',
			placement: { kind: 'relative', referenceChatId: 'p2-b', position: 'after' },
			visibleOrder: ['p1-a', 'p2-b', 'p2-a', 'p1-b'],
			sequence: 1,
		});
	});

	it('does not persist scoped single-item moves', () => {
		const visibleOrders = buildOrders(['p1-a', 'p2-a']);
		const reorder = new SidebarChatReorderState({
			get visibleOrders() {
				return visibleOrders;
			},
		});

		reorder.begin('normal', 'p2-a', { ids: ['p2-a'] });
		reorder.preview({
			list: 'normal',
			sourceChatId: 'p2-a',
			targetChatId: 'p1-a',
			closestEdge: 'top',
		});

		expect(reorder.finish('normal')).toBeNull();
	});

	it('keeps menu boundary moves inside the provided scope', () => {
		const visibleOrders = buildOrders(['p1-a', 'p1-b', 'p2-a', 'p2-b']);
		const reorder = new SidebarChatReorderState({
			get visibleOrders() {
				return visibleOrders;
			},
		});

		expect(
			reorder.moveToBoundary({
				list: 'normal',
				chatId: 'p2-b',
				boundary: 'start',
				scope: { ids: ['p2-a', 'p2-b'] },
			}),
		).toEqual({
			kind: 'relative',
			list: 'normal',
			chatId: 'p2-b',
			placement: { kind: 'relative', referenceChatId: 'p2-a', position: 'before' },
			visibleOrder: ['p1-a', 'p1-b', 'p2-b', 'p2-a'],
			sequence: 1,
		});
	});
});
