import { describe, expect, it, vi } from 'vitest';
import type { ReorderChatRequest, ReorderChatResponse } from '$shared/chat-order-contracts';
import {
	SidebarOrderController,
	applySidebarRelativeMove,
} from '../sidebar-order-controller.svelte';
import { buildSidebarChatOrderMap, buildSidebarRowModel } from '../sidebar-row-model';
import { chat, delegated, projectionInput } from './sidebar-fixtures';
import { SidebarOrderTestInput } from './sidebar-order-test-input.svelte';

function fixture() {
	const input = new SidebarOrderTestInput(
		projectionInput(
			['a', 'hidden', 'b', 'c'].map((id) => chat(id)),
			{ matchingChatIds: new Set(['a', 'b', 'c']) },
		),
	);
	const write = vi
		.fn<(request: ReorderChatRequest) => Promise<ReorderChatResponse>>()
		.mockImplementation(async ({ chatId }) => ({
			success: true,
			chatId,
			orderGroup: 'normal',
			changed: true,
		}));
	const refresh = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
	const sort = vi.fn<() => Promise<{ changed: boolean }>>().mockResolvedValue({ changed: false });
	const onError = vi.fn();
	const controller = new SidebarOrderController({
		get input() {
			return input.current;
		},
		write,
		refresh,
		sort,
		onError,
	});
	const move = (source: string, target: string, edge: 'top' | 'bottom' = 'top') => {
		const row = buildSidebarRowModel({ ...input.current, orders: controller.orders }).rows.find(
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
			return input.current;
		},
		set input(next) {
			input.current = next;
		},
	};
}

describe('SidebarOrderController', () => {
	it.each([false, true])(
		'invalidates existing gestures and requests on archive separation changes (%s)',
		(separateArchivedBranches) => {
			const f = fixture();
			f.input = { ...f.input, separateArchivedBranches };
			const request = f.move('c', 'a')!;
			expect(request).not.toBeNull();
			f.controller.begin('normal', 'c', { ids: ['a', 'b', 'c'] });
			f.controller.preview({
				list: 'normal',
				sourceChatId: 'c',
				targetChatId: 'a',
				closestEdge: 'top',
			});
			f.input = { ...f.input, separateArchivedBranches: !separateArchivedBranches };
			expect(f.controller.dragPresentationChanged).toBe(true);
			expect(f.controller.orders.normal).toEqual(f.input.orders.normal);
			expect(f.controller.finish('normal')).toBeNull();
			f.controller.submit(request);
			expect(f.write).not.toHaveBeenCalled();
		},
	);

	it('ignores archive separation changes while nesting is disabled', () => {
		const f = fixture();
		f.input = { ...f.input, nestDelegatedChats: false };
		f.controller.begin('normal', 'c', { ids: ['a', 'b', 'c'] });
		f.controller.preview({
			list: 'normal',
			sourceChatId: 'c',
			targetChatId: 'a',
			closestEdge: 'top',
		});
		f.input = { ...f.input, separateArchivedBranches: true };
		expect(f.controller.dragPresentationChanged).toBe(false);
		expect(f.controller.finish('normal')).not.toBeNull();
	});

	it('moves a separated archived branch among archive roots without moving descendants', async () => {
		const f = fixture();
		f.input = projectionInput(
			[
				chat('parent'),
				delegated('archive', 'parent', { isArchived: true }),
				delegated('live', 'archive'),
				chat('peer', { isArchived: true }),
			],
			{ separateArchivedBranches: true },
		);
		const request = f.move('peer', 'archive')!;
		expect(request).not.toBeNull();
		f.refresh.mockResolvedValue(false);
		f.controller.submit(request);
		await vi.waitFor(() => expect(f.controller.recoveryRequired).toBe(true));
		expect(f.write).toHaveBeenCalledExactlyOnceWith({
			chatId: 'peer',
			placement: { kind: 'relative', referenceChatId: 'archive', position: 'before' },
		});
		expect(f.controller.orders.normal).toEqual(['parent', 'live']);
		expect(f.controller.projection.rowModel.visibleChatIds).toEqual([
			'parent',
			'peer',
			'archive',
			'live',
		]);
	});

	it('rejoins a restored branch after an optimistic archive rolls back', () => {
		const f = fixture();
		const chats = [
			chat('parent'),
			delegated('child', 'parent'),
			delegated('grandchild', 'child'),
			chat('other'),
		];
		f.input = projectionInput(chats, { separateArchivedBranches: true });
		expect(f.controller.projection.rowModel.visibleChatIds).toEqual([
			'parent',
			'child',
			'grandchild',
			'other',
		]);
		f.input = projectionInput(
			chats.map((chat) => (chat.id === 'child' ? { ...chat, isArchived: true } : chat)),
			{
				separateArchivedBranches: true,
				isChatOptimisticallyArchived: (id) => id === 'child',
			},
		);
		expect(f.controller.projection.rowModel.visibleChatIds).toEqual([
			'parent',
			'other',
			'child',
			'grandchild',
		]);
		f.input = projectionInput(chats, { separateArchivedBranches: true });
		expect(f.controller.projection.rowModel.visibleChatIds).toEqual([
			'parent',
			'child',
			'grandchild',
			'other',
		]);
	});

	it('resolves adjacent actions from live peers without consuming a pointer drag', () => {
		const f = fixture();
		const request = () => f.controller.moveAdjacent({ list: 'normal', chatId: 'c', offset: -1 });
		expect(request()?.placement).toEqual({
			kind: 'relative',
			referenceChatId: 'b',
			position: 'before',
		});
		f.input = {
			...f.input,
			allChats: [...f.input.allChats.slice(0, -1), chat('new'), chat('c')],
			matchingChatIds: undefined,
		};
		expect(request()?.placement.referenceChatId).toBe('new');
		f.controller.begin('normal', 'a', { ids: ['a'] });
		expect(request()).toBeNull();
		expect(f.controller.activeChatId).toBe('a');
	});
	it.each(['top', 'bottom'] as const)(
		'keeps canonical %s commands independent of sidebar filters and sort mode',
		async (boundary) => {
			const f = fixture();
			f.input = { ...f.input, sortMode: 'recent', matchingChatIds: new Set(['a']) };
			const response: ReorderChatResponse = {
				success: true,
				chatId: 'c',
				orderGroup: 'normal',
				changed: false,
			};
			f.write.mockResolvedValue(response);
			expect(await f.controller.moveChatToBoundary('c', boundary)).toEqual(response);
			expect(f.write).toHaveBeenCalledExactlyOnceWith({
				chatId: 'c',
				placement: { kind: 'boundary', boundary },
			});
			expect(f.refresh).toHaveBeenCalledOnce();
		},
	);
	it('blocks sidebar and boundary writes until a boundary command refresh settles', async () => {
		const f = fixture();
		const sidebarMove = f.move('c', 'b')!;
		const refresh = Promise.withResolvers<boolean>();
		f.refresh.mockReturnValueOnce(refresh.promise);
		const command = f.controller.moveChatToBoundary('a', 'bottom');
		expect(await f.controller.moveChatToBoundary('c', 'top')).toBeNull();
		f.controller.submit(sidebarMove);
		expect(f.move('c', 'b')).toBeNull();
		expect(await f.controller.sort('activity')).toBe(false);
		await vi.waitFor(() => expect(f.refresh).toHaveBeenCalledOnce());
		expect(f.write).toHaveBeenCalledOnce();
		refresh.resolve(false);
		expect(await command).toMatchObject({ chatId: 'a', changed: true });
		expect(f.controller.recoveryRequired).toBe(true);
		expect(await f.controller.moveChatToBoundary('c', 'top')).toBeNull();
		f.refresh.mockResolvedValue(true);
		await f.controller.recover();
		expect(await f.controller.moveChatToBoundary('c', 'top')).toMatchObject({ chatId: 'c' });
		expect(f.write).toHaveBeenCalledTimes(2);
	});
	it('reports a failed boundary write and guards recovery without resending', async () => {
		const f = fixture();
		const error = new TypeError('Connection lost');
		f.write.mockRejectedValueOnce(error);
		f.refresh.mockResolvedValue(false);
		expect(await f.controller.moveChatToBoundary('a', 'bottom')).toBeNull();
		expect(f.onError).toHaveBeenCalledWith(error, 'unconfirmed');
		expect(f.controller.recoveryRequired).toBe(true);
		f.refresh.mockResolvedValue(true);
		await f.controller.recover();
		expect(f.write).toHaveBeenCalledOnce();
	});
	it.each(['context', 'cycle'] as const)(
		'persists visible moves across an ineligible %s branch',
		async (kind) => {
			for (const [source, target, edge, expected] of [
				['a', 'c', 'top', ['x', 'y', 'a', 'c']],
				['c', 'a', 'bottom', ['a', 'c', 'x', 'y']],
			] as const) {
				const f = fixture();
				f.input = projectionInput(
					[
						chat('a'),
						kind === 'context' ? chat('x') : delegated('x', 'y'),
						delegated('y', 'x'),
						chat('c'),
					],
					kind === 'context' ? { matchingChatIds: new Set(['a', 'y', 'c']) } : {},
				);
				expect(f.move(source, 'x')).toBeNull();
				f.controller.begin('normal', source, { ids: ['a', 'c'] });
				f.controller.preview({
					list: 'normal',
					sourceChatId: source,
					targetChatId: target,
					closestEdge: edge,
				});
				expect(f.controller.projection.rowModel.visibleChatIds).toEqual(expected);
				const request = f.controller.finish('normal');
				expect(request).not.toBeNull();
				f.refresh.mockResolvedValue(false);
				f.controller.submit(request!);
				await vi.waitFor(() => expect(f.controller.recoveryRequired).toBe(true));
				expect(f.write).toHaveBeenCalledExactlyOnceWith({
					chatId: source,
					placement: {
						kind: 'relative',
						referenceChatId: target,
						position: edge === 'top' ? 'before' : 'after',
					},
				});
				expect(f.controller.projection.rowModel.visibleChatIds).toEqual(expected);
			}
		},
	);
	it('previews a newly matching peer instead of retaining the previous target', () => {
		const f = fixture();
		f.controller.begin('normal', 'c', { ids: ['a', 'b', 'c'] });
		f.controller.preview({
			list: 'normal',
			sourceChatId: 'c',
			targetChatId: 'a',
			closestEdge: 'top',
		});
		f.input = { ...f.input, matchingChatIds: undefined };
		f.controller.preview({
			list: 'normal',
			sourceChatId: 'c',
			targetChatId: 'hidden',
			closestEdge: 'top',
		});
		expect(f.controller.orders.normal).toEqual(['a', 'c', 'hidden', 'b']);
		expect(f.controller.finish('normal')?.placement.referenceChatId).toBe('hidden');
	});
	it('drops stale previews when a peer leaves the scope and accepts another live peer', () => {
		const f = fixture();
		f.controller.begin('normal', 'c', { ids: ['a', 'b', 'c'] });
		f.controller.preview({
			list: 'normal',
			sourceChatId: 'c',
			targetChatId: 'a',
			closestEdge: 'top',
		});
		f.input = { ...f.input, matchingChatIds: new Set(['b', 'c']) };
		expect(f.controller.orders.normal).toEqual(f.input.orders.normal);
		f.controller.preview({
			list: 'normal',
			sourceChatId: 'c',
			targetChatId: 'a',
			closestEdge: 'top',
		});
		expect(f.controller.finish('normal')).toBeNull();
		const move = f.move('c', 'b');
		expect(move?.placement.referenceChatId).toBe('b');
	});
	it.each(['filtered', 'delegated', 'grouped'] as const)(
		'ignores visually unchanged moves across %s non-peers',
		(mode) => {
			const f = fixture();
			f.input =
				mode === 'filtered'
					? projectionInput([chat('a'), chat('hidden'), chat('b')], {
							matchingChatIds: new Set(['a', 'b']),
						})
					: mode === 'delegated'
						? projectionInput([chat('a'), delegated('hidden', 'a'), chat('b')])
						: projectionInput([chat('a'), chat('hidden', { projectPath: '/other' }), chat('b')], {
								groupingFields: [{ field: 'project', enabled: true }],
							});
			expect(f.move('a', 'b', 'top')).toBeNull();
			expect(f.move('b', 'a', 'bottom')).toBeNull();
			expect(f.controller.orders.normal).toEqual(['a', 'hidden', 'b']);
			expect(f.write).not.toHaveBeenCalled();
		},
	);
	it('blocks other order bands while a move is unsettled', async () => {
		const f = fixture();
		f.input = projectionInput([
			chat('a'),
			chat('b'),
			chat('p', { isPinned: true }),
			chat('q', { isPinned: true }),
		]);
		const pinned = f.move('q', 'p')!;
		f.refresh.mockResolvedValue(false);
		f.controller.submit(f.move('b', 'a')!);
		f.controller.submit(pinned);
		await vi.waitFor(() => expect(f.controller.recoveryRequired).toBe(true));
		expect(f.move('q', 'p')).toBeNull();
		expect(f.write).toHaveBeenCalledOnce();
		expect(f.controller.orders.pinned).toEqual(['p', 'q']);
	});
	it('keeps recovery explicit without duplicating session-owned refresh notifications', async () => {
		const f = fixture();
		f.refresh.mockRejectedValue(new Error('Offline'));
		f.controller.submit(f.move('c', 'b')!);
		await vi.waitFor(() => expect(f.controller.recoveryRequired).toBe(true));
		await f.controller.recover();
		expect(f.controller.recoveryRequired).toBe(true);
		expect(f.onError).not.toHaveBeenCalled();
		expect(f.write).toHaveBeenCalledOnce();
	});
	it.each(['move', 'sort'] as const)(
		'classifies rejected and unknown errors for %s',
		async (operation) => {
			for (const rejected of [true, false]) {
				const f = fixture();
				const error = rejected
					? { errorCode: 'VALIDATION_FAILED' }
					: new TypeError('Connection lost');
				if (operation === 'move') {
					f.write.mockRejectedValue(error);
					f.controller.submit(f.move('c', 'b')!);
					await vi.waitFor(() => expect(f.controller.busy).toBe(false));
				} else {
					f.sort.mockRejectedValue(error);
					await f.controller.sort('activity');
				}
				expect(f.onError).toHaveBeenCalledExactlyOnceWith(
					error,
					rejected ? 'rejected' : 'unconfirmed',
				);
			}
		},
	);
	it('retains the projection for identical previews and clears only the placement', () => {
		const f = fixture();
		f.controller.begin('normal', 'c', { ids: ['a', 'b', 'c'] });
		const preview = {
			list: 'normal',
			sourceChatId: 'c',
			targetChatId: 'b',
			closestEdge: 'top',
		} as const;
		f.controller.preview(preview);
		const projected = f.controller.projection;
		f.controller.preview(preview);
		expect(f.controller.projection).toBe(projected);
		f.controller.clearPreview();
		expect(f.controller.orders.normal).toEqual(f.input.orders.normal);
		expect(f.controller.activeChatId).toBe('c');
		f.controller.preview(preview);
		expect(f.controller.finish('normal')?.placement.referenceChatId).toBe('b');
	});
	it('does not cancel a drag when optional presentation values are normalized', () => {
		const f = fixture();
		f.input = { ...f.input, groupingFields: [], groupNestedProjectPaths: undefined };
		f.controller.begin('normal', 'c', { ids: ['a', 'b', 'c'] });
		f.controller.preview({
			list: 'normal',
			sourceChatId: 'c',
			targetChatId: 'b',
			closestEdge: 'top',
		});
		f.input = { ...f.input, groupNestedProjectPaths: false };
		expect(f.controller.dragPresentationChanged).toBe(false);
		expect(f.controller.finish('normal')).not.toBeNull();
	});
	it('allows the next project move after settlement changes path spelling order', async () => {
		const f = fixture();
		f.input = projectionInput(
			[
				chat('a', { projectPath: '/repo/' }),
				chat('b', { projectPath: '/repo' }),
				chat('c', { projectPath: '/repo' }),
			],
			{ groupingFields: [{ field: 'project', enabled: true }] },
		);
		const refresh = Promise.withResolvers<boolean>();
		f.refresh.mockReturnValueOnce(refresh.promise);
		f.controller.submit(f.move('b', 'a')!);
		expect(f.move('c', 'a')).toBeNull();
		await vi.waitFor(() => expect(f.refresh).toHaveBeenCalledOnce());
		const [a, b, c] = f.input.allChats;
		f.input = { ...f.input, allChats: [b, a, c] };
		refresh.resolve(true);
		await vi.waitFor(() => expect(f.controller.busy).toBe(false));
		f.controller.submit(f.move('c', 'a')!);
		await vi.waitFor(() => expect(f.controller.busy).toBe(false));
		expect(f.write).toHaveBeenCalledTimes(2);
	});
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
		f.controller.submit(f.move('c', 'b')!);
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
	it('blocks additional moves and bulk sort until the authoritative refresh settles', async () => {
		const f = fixture();
		const refresh = Promise.withResolvers<boolean>();
		f.refresh.mockReturnValueOnce(refresh.promise);
		const second = f.move('a', 'c', 'bottom')!;
		f.controller.submit(f.move('c', 'b')!);
		f.controller.submit(second);
		expect(f.move('a', 'c', 'bottom')).toBeNull();
		expect(await f.controller.sort('activity')).toBe(false);
		await vi.waitFor(() => expect(f.refresh).toHaveBeenCalledOnce());
		expect(f.write).toHaveBeenCalledOnce();
		expect(f.controller.orders.normal).toEqual(['a', 'hidden', 'c', 'b']);
		f.input = projectionInput([chat('a'), chat('hidden'), chat('c'), chat('b')]);
		refresh.resolve(true);
		await vi.waitFor(() => expect(f.controller.busy).toBe(false));
		expect(f.write).toHaveBeenCalledOnce();
		expect(f.sort).not.toHaveBeenCalled();
	});
	it('removes a definitely rejected overlay even if refresh fails', async () => {
		const f = fixture();
		f.write.mockRejectedValueOnce({ errorCode: 'ORDER_CROSS_GROUP' });
		f.refresh.mockResolvedValue(false);
		f.controller.submit(f.move('c', 'b')!);
		await vi.waitFor(() => expect(f.controller.recoveryRequired).toBe(true));
		expect(f.controller.orders.normal).toEqual(f.input.orders.normal);
		expect(f.controller.busy).toBe(true);
		expect(f.onError).toHaveBeenCalledOnce();
		expect(f.write).toHaveBeenCalledOnce();
	});
	it('does not start concurrent recoveries or admit mutations during recovery', async () => {
		const f = fixture();
		f.refresh.mockResolvedValue(false);
		f.controller.submit(f.move('c', 'b')!);
		await vi.waitFor(() => expect(f.controller.recoveryRequired).toBe(true));
		const refresh = Promise.withResolvers<boolean>();
		f.refresh.mockReturnValueOnce(refresh.promise);
		const recovery = f.controller.recover();
		await f.controller.recover();
		expect(f.refresh).toHaveBeenCalledTimes(2);
		expect(f.controller.recovering).toBe(true);
		expect(f.move('a', 'b', 'bottom')).toBeNull();
		expect(await f.controller.sort('activity')).toBe(false);
		refresh.resolve(true);
		await recovery;
		expect(f.controller.busy).toBe(false);
		expect(f.controller.recovering).toBe(false);
		f.refresh.mockResolvedValue(false);
		await f.controller.sort('activity');
		expect(f.controller.recoveryRequired).toBe(true);
	});
	it('does not resend an unknown mutation and waits for authoritative recovery', async () => {
		const f = fixture();
		f.write.mockRejectedValueOnce(new TypeError('Connection lost'));
		f.refresh.mockResolvedValue(false);
		f.controller.submit(f.move('c', 'b')!);
		await vi.waitFor(() => expect(f.controller.recoveryRequired).toBe(true));
		expect(f.controller.orders.normal).toEqual(['a', 'hidden', 'c', 'b']);
		expect(f.move('a', 'b', 'bottom')).toBeNull();
		expect(f.write).toHaveBeenCalledOnce();
		f.refresh.mockResolvedValue(true);
		await f.controller.recover();
		await vi.waitFor(() => expect(f.controller.busy).toBe(false));
		expect(f.controller.orders.normal).toEqual(f.input.orders.normal);
		expect(f.write).toHaveBeenCalledOnce();
		expect(f.write.mock.calls.filter(([request]) => request.chatId === 'c')).toHaveLength(1);
	});
	it('rejects stale parent scopes and cross-parent targets before dispatch', () => {
		const f = fixture();
		f.input = projectionInput([chat('a'), delegated('a1', 'a'), delegated('a2', 'a'), chat('b')]);
		expect(f.move('a1', 'b')).toBeNull();
		const request = f.move('a2', 'a1')!;
		f.input = projectionInput(f.input.allChats.filter((chat) => chat.id !== 'a'));
		f.controller.submit(request);
		expect(f.write).not.toHaveBeenCalled();
	});
	it('ignores deleted anchors while rebasing the pending move', async () => {
		const f = fixture();
		f.refresh.mockResolvedValue(false);
		f.controller.submit(f.move('c', 'b')!);
		await vi.waitFor(() => expect(f.controller.recoveryRequired).toBe(true));
		f.input = projectionInput(f.input.allChats.filter((chat) => chat.id !== 'b'));
		expect(f.controller.orders.normal).toEqual(['a', 'hidden', 'c']);
		f.refresh.mockResolvedValue(true);
		await f.controller.recover();
		await vi.waitFor(() => expect(f.controller.busy).toBe(false));
		expect(f.write).toHaveBeenCalledOnce();
	});
	it('keeps menu boundaries inside visible sibling scope', () => {
		const f = fixture();
		f.input = projectionInput([chat('a'), delegated('b', 'a'), delegated('c', 'a')]);
		const request = f.controller.moveToBoundary({
			list: 'normal',
			chatId: 'c',
			boundary: 'start',
		});
		expect(request?.placement).toEqual({
			kind: 'relative',
			referenceChatId: 'b',
			position: 'before',
		});
	});
	it.each(['start', 'end'] as const)(
		'resolves the live %s boundary after peer arrival and departure',
		(boundary) => {
			const f = fixture();
			const chats = [
				chat('parent'),
				delegated('a', 'parent'),
				delegated('b', 'parent'),
				delegated('c', 'parent'),
			];
			f.input = projectionInput(chats);
			const source = boundary === 'start' ? 'c' : 'a';
			const request = () =>
				f.controller.moveToBoundary({ list: 'normal', chatId: source, boundary });
			expect(request()?.placement.referenceChatId).toBe(boundary === 'start' ? 'a' : 'c');
			const arrival = delegated('new', 'parent');
			f.input = projectionInput(boundary === 'start' ? [arrival, ...chats] : [...chats, arrival]);
			expect(request()?.placement.referenceChatId).toBe('new');
			f.input = projectionInput(
				chats.filter((chat) => chat.id !== (boundary === 'start' ? 'a' : 'c')),
			);
			expect(request()?.placement.referenceChatId).toBe('b');
		},
	);
	it('does not let bulk sort overtake moves or admit moves while sorting', async () => {
		const f = fixture();
		f.refresh.mockResolvedValue(false);
		f.controller.submit(f.move('c', 'b')!);
		await f.controller.sort('activity');
		expect(f.sort).not.toHaveBeenCalled();
		await vi.waitFor(() => expect(f.controller.recoveryRequired).toBe(true));
		f.refresh.mockResolvedValue(true);
		await f.controller.recover();
		const sort = Promise.withResolvers<{ changed: boolean }>();
		f.sort.mockReturnValueOnce(sort.promise);
		const request = f.move('c', 'b')!;
		const sorting = f.controller.sort('activity');
		f.controller.submit(request);
		expect(f.write).toHaveBeenCalledOnce();
		sort.resolve({ changed: true });
		await sorting;
		expect(f.controller.busy).toBe(false);
	});
	it('disposes pending state without replaying late work', async () => {
		const f = fixture();
		const write = Promise.withResolvers<ReorderChatResponse>();
		f.write.mockReturnValueOnce(write.promise);
		f.controller.submit(f.move('c', 'b')!);
		expect(f.write).toHaveBeenCalledOnce();
		f.controller.destroy();
		write.resolve({ success: true, chatId: 'c', orderGroup: 'normal', changed: true });
		await Promise.resolve();
		expect(f.controller.busy).toBe(false);
		expect(f.refresh).not.toHaveBeenCalled();
		expect(f.controller.orders).toEqual(buildSidebarChatOrderMap(f.input.allChats));
	});
});
