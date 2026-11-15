import { describe, expect, it, vi } from 'vitest';
import type { ReorderChatRequest } from '$shared/chat-order-contracts';
import {
	SidebarOrderController,
	applySidebarRelativeMove,
} from '../sidebar-order-controller.svelte';
import { buildSidebarChatOrderMap, buildSidebarRowModel } from '../sidebar-row-model';
import { chat, delegated, projectionInput } from './sidebar-fixtures';

function fixture() {
	let input = projectionInput(
		['a', 'hidden', 'b', 'c'].map((id) => chat(id)),
		{ matchingChatIds: new Set(['a', 'b', 'c']) },
	);
	const write = vi
		.fn<(request: ReorderChatRequest) => Promise<unknown>>()
		.mockResolvedValue(undefined);
	const refresh = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
	const sort = vi.fn<() => Promise<{ changed: boolean }>>().mockResolvedValue({ changed: false });
	const onError = vi.fn();
	const controller = new SidebarOrderController({
		get input() {
			return input;
		},
		write,
		refresh,
		sort,
		onError,
	});
	const move = (source: string, target: string, edge: 'top' | 'bottom' = 'top') => {
		const row = buildSidebarRowModel({ ...input, orders: controller.orders }).rows.find(
			(row) => row.type === 'chat' && row.chat.id === source,
		);
		if (row?.type !== 'chat') throw new Error('Missing source');
		controller.begin(row.list, source, { ids: row.reorderScopeIds });
		controller.preview({
			list: row.list,
			sourceChatId: source,
			targetChatId: target,
			closestEdge: edge,
		});
		return controller.finish(row.list);
	};
	return {
		controller,
		move,
		write,
		refresh,
		sort,
		onError,
		get input() {
			return input;
		},
		set input(next) {
			input = next;
		},
	};
}

describe('SidebarOrderController', () => {
	it('cancels a transient drag when presentation changes even if its leaf key is unchanged', () => {
		const f = fixture();
		f.controller.begin('normal', 'c', { ids: ['a', 'b', 'c'] });
		f.controller.preview({
			list: 'normal',
			sourceChatId: 'c',
			targetChatId: 'b',
			closestEdge: 'top',
		});
		f.input = { ...f.input, groupNestedProjectPaths: true };
		expect(f.controller.dragPresentationChanged).toBe(true);
		expect(f.controller.finish('normal')).toBeNull();
		expect(f.controller.orders.normal).toEqual(f.input.orders.normal);
	});
	it('does not submit an anchor that stopped matching during a drag', () => {
		const f = fixture();
		f.controller.begin('normal', 'c', { ids: ['a', 'b', 'c'] });
		f.controller.preview({
			list: 'normal',
			sourceChatId: 'c',
			targetChatId: 'b',
			closestEdge: 'top',
		});
		f.input = { ...f.input, matchingChatIds: new Set(['a', 'c']) };
		expect(f.controller.finish('normal')).toBeNull();
	});
	it('preserves the actual target edge across hidden peers', () => {
		const f = fixture();
		const move = f.move('c', 'b');
		expect(move?.placement).toEqual({ kind: 'relative', referenceChatId: 'b', position: 'before' });
		expect(applySidebarRelativeMove(f.input.orders.normal, 'c', move!.placement)).toEqual([
			'a',
			'hidden',
			'c',
			'b',
		]);
	});
	it('keeps drag previews idempotent and cancels only transient state', () => {
		const f = fixture();
		f.controller.begin('normal', 'a', { ids: ['a', 'b', 'c'] });
		for (let index = 0; index < 3; index++)
			f.controller.preview({
				list: 'normal',
				sourceChatId: 'a',
				targetChatId: 'c',
				closestEdge: 'bottom',
			});
		expect(f.controller.orders.normal).toEqual(['hidden', 'b', 'c', 'a']);
		f.controller.cancel();
		expect(f.controller.orders.normal).toEqual(f.input.orders.normal);
		expect(f.controller.finish('normal')).toBeNull();
	});
	it('keeps an acknowledged move while refresh fails, including after filtering and collapse change', async () => {
		const f = fixture();
		f.refresh.mockResolvedValue(false);
		f.controller.enqueue(f.move('c', 'b')!);
		await vi.waitFor(() => expect(f.controller.recoveryRequired).toBe(true));
		f.input = {
			...f.input,
			matchingChatIds: new Set(['a']),
			collapsedProjectKeys: new Set(['delegation:a']),
		};
		expect(f.controller.orders.normal).toEqual(['a', 'hidden', 'c', 'b']);
		f.input = { ...f.input, allChats: [chat('b'), chat('a'), chat('hidden'), chat('c')] };
		f.refresh.mockResolvedValue(true);
		await f.controller.recover();
		expect(f.controller.orders.normal).toEqual(['b', 'a', 'hidden', 'c']);
		expect(f.write).toHaveBeenCalledTimes(1);
	});
	it('serializes drops within a band and preserves newer intents through earlier completion', async () => {
		const f = fixture();
		let release!: () => void;
		f.refresh.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = () => resolve(true);
				}),
		);
		f.controller.enqueue(f.move('c', 'b')!);
		f.controller.enqueue(f.move('a', 'c', 'bottom')!);
		await vi.waitFor(() => expect(f.refresh).toHaveBeenCalledOnce());
		expect(f.write).toHaveBeenCalledOnce();
		expect(f.controller.orders.normal).toEqual(['hidden', 'c', 'a', 'b']);
		f.input = projectionInput([chat('a'), chat('hidden'), chat('c'), chat('b')]);
		release();
		await vi.waitFor(() => expect(f.write).toHaveBeenCalledTimes(2));
		expect(f.write.mock.calls[1][0]).toMatchObject({
			chatId: 'a',
			placement: { referenceChatId: 'c', position: 'after' },
		});
	});
	it('rebases remaining intents after a definite rejection without restoring an old snapshot', async () => {
		const f = fixture();
		f.write.mockRejectedValueOnce({ errorCode: 'ORDER_CROSS_GROUP' });
		f.controller.enqueue(f.move('c', 'b')!);
		f.controller.enqueue(f.move('a', 'b', 'bottom')!);
		await vi.waitFor(() => expect(f.controller.busy).toBe(false));
		expect(f.onError).toHaveBeenCalledOnce();
		expect(f.write).toHaveBeenCalledTimes(2);
	});
	it('validates queued activity moves against their captured inactivity preference', async () => {
		const f = fixture();
		f.input = projectionInput(
			['a', 'b', 'c'].map((id) => chat(id, { lastActivityAt: '2026-01-28T12:00:00.000Z' })),
			{ groupingFields: [{ field: 'activity', enabled: true }] },
		);
		f.refresh.mockResolvedValue(false);
		f.controller.enqueue(f.move('c', 'b')!);
		await vi.waitFor(() => expect(f.controller.recoveryRequired).toBe(true));
		f.controller.enqueue(f.move('a', 'b', 'bottom')!);
		f.input = { ...f.input, inactivityDuration: '1-week' };
		f.refresh.mockResolvedValue(true);
		await f.controller.recover();
		await vi.waitFor(() => expect(f.controller.busy).toBe(false));
		expect(f.write).toHaveBeenCalledTimes(2);
	});
	it('does not resend an unknown mutation and waits for authoritative recovery', async () => {
		const f = fixture();
		f.write.mockRejectedValueOnce(new TypeError('Connection lost'));
		f.refresh.mockResolvedValue(false);
		f.controller.enqueue(f.move('c', 'b')!);
		await vi.waitFor(() => expect(f.controller.recoveryRequired).toBe(true));
		f.controller.enqueue(f.move('a', 'b', 'bottom')!);
		expect(f.write).toHaveBeenCalledOnce();
		f.refresh.mockResolvedValue(true);
		await f.controller.recover();
		await vi.waitFor(() => expect(f.controller.busy).toBe(false));
		expect(f.write).toHaveBeenCalledTimes(2);
		expect(f.write.mock.calls.filter(([request]) => request.chatId === 'c')).toHaveLength(1);
	});
	it('rejects stale parent scopes and cross-parent targets before dispatch', () => {
		const f = fixture();
		f.input = projectionInput([chat('a'), delegated('a1', 'a'), delegated('a2', 'a'), chat('b')]);
		expect(f.move('a1', 'b')).toBeNull();
		const request = f.move('a2', 'a1')!;
		f.input = projectionInput(f.input.allChats.filter((chat) => chat.id !== 'a'));
		f.controller.enqueue(request);
		expect(f.write).not.toHaveBeenCalled();
	});
	it('ignores deleted anchors and changed membership while rebasing queued moves', async () => {
		const f = fixture();
		f.refresh.mockResolvedValue(false);
		f.controller.enqueue(f.move('c', 'b')!);
		await vi.waitFor(() => expect(f.controller.recoveryRequired).toBe(true));
		f.controller.enqueue(f.move('a', 'b')!);
		f.input = projectionInput(f.input.allChats.filter((chat) => chat.id !== 'b'));
		f.refresh.mockResolvedValue(true);
		await f.controller.recover();
		await vi.waitFor(() => expect(f.controller.busy).toBe(false));
		expect(f.write).toHaveBeenCalledOnce();
	});
	it('keeps menu boundaries inside visible sibling scope', () => {
		const f = fixture();
		const request = f.controller.moveToBoundary({
			list: 'normal',
			chatId: 'c',
			boundary: 'start',
			scope: { ids: ['b', 'c'] },
		});
		expect(request?.placement).toEqual({
			kind: 'relative',
			referenceChatId: 'b',
			position: 'before',
		});
	});
	it('does not let bulk sort overtake moves or admit moves while sorting', async () => {
		const f = fixture();
		f.refresh.mockResolvedValue(false);
		f.controller.enqueue(f.move('c', 'b')!);
		await f.controller.sort('activity');
		expect(f.sort).not.toHaveBeenCalled();
		await vi.waitFor(() => expect(f.controller.recoveryRequired).toBe(true));
		f.refresh.mockResolvedValue(true);
		await f.controller.recover();
		let release!: () => void;
		f.sort.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = () => resolve({ changed: true });
				}),
		);
		const request = f.move('c', 'b')!;
		const sorting = f.controller.sort('activity');
		f.controller.enqueue(request);
		expect(f.write).toHaveBeenCalledOnce();
		release();
		await sorting;
		expect(f.controller.busy).toBe(false);
	});
	it('disposes pending state without replaying late work', async () => {
		const f = fixture();
		let release!: () => void;
		f.write.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = () => resolve(undefined);
				}),
		);
		f.controller.enqueue(f.move('c', 'b')!);
		f.controller.destroy();
		release();
		await Promise.resolve();
		expect(f.controller.busy).toBe(false);
		expect(f.refresh).not.toHaveBeenCalled();
		expect(f.controller.orders).toEqual(buildSidebarChatOrderMap(f.input.allChats));
	});
});
