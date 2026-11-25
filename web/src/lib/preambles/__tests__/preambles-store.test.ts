import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '$lib/api/client';
import { PreamblesStore } from '../preambles-store.svelte';
import type { Preamble, PreamblesSnapshot } from '$shared/preambles';

function preamble(id: string): Preamble {
	return {
		id,
		enabled: true,
		title: `Preamble ${id}`,
		content: `Content ${id}`,
		scope: { type: 'global' },
		agentIds: [],
		tagFilter: { mode: 'any', tags: [] },
		createdAt: '2029-01-01T00:00:00.000Z',
		updatedAt: '2029-01-01T00:00:00.000Z',
	};
}

function snapshot(revision: number, ids: string[]): PreamblesSnapshot {
	return { revision, preambles: ids.map(preamble) };
}

describe('PreamblesStore', () => {
	it('publishes invalidations without eagerly loading the catalog', async () => {
		const get = vi.fn();
		const store = new PreamblesStore({ get });

		await store.refreshIfLoaded();

		expect(store.invalidationVersion).toBe(1);
		expect(get).not.toHaveBeenCalled();
	});

	it('loads lazily and applies canonical mutation snapshots', async () => {
		const get = vi.fn().mockResolvedValue(snapshot(0, []));
		const create = vi.fn().mockResolvedValue({ success: true, snapshot: snapshot(1, ['a']) });
		const store = new PreamblesStore({ get, create });

		expect(get).not.toHaveBeenCalled();
		await store.ensureLoaded();
		await store.create({
			enabled: true,
			title: 'Preamble a',
			content: 'Content a',
			scope: { type: 'global' },
		});

		expect(create).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 0 }));
		expect(store.snapshot).toEqual(snapshot(1, ['a']));
	});

	it('optimistically reorders and applies the server revision', async () => {
		let resolveMutation!: (value: { success: true; snapshot: PreamblesSnapshot }) => void;
		const reorder = vi.fn(
			() =>
				new Promise<{ success: true; snapshot: PreamblesSnapshot }>((resolve) => {
					resolveMutation = resolve;
				}),
		);
		const store = new PreamblesStore({ reorder });
		store.applySnapshot(snapshot(2, ['a', 'b']));

		const moving = store.move('b', 'up');
		await vi.waitFor(() => expect(reorder).toHaveBeenCalledOnce());
		expect(store.preambles.map((entry) => entry.id)).toEqual(['b', 'a']);
		resolveMutation({ success: true, snapshot: snapshot(3, ['b', 'a']) });
		await moving;

		expect(reorder).toHaveBeenCalledWith({
			expectedRevision: 2,
			orderedPreambleIds: ['b', 'a'],
		});
		expect(store.snapshot?.revision).toBe(3);
	});

	it('rolls back an optimistic reorder when the mutation fails', async () => {
		const failure = new Error('reorder failed');
		const reorder = vi.fn().mockRejectedValue(failure);
		const store = new PreamblesStore({ reorder });
		store.applySnapshot(snapshot(2, ['a', 'b']));

		await expect(store.move('b', 'up')).rejects.toBe(failure);

		expect(store.preambles.map((entry) => entry.id)).toEqual(['a', 'b']);
	});

	it('refreshes a stale edit after a revision conflict without advancing its revision', async () => {
		const conflict = new ApiError(409, 'revision conflict', 'PREAMBLE_REVISION_CONFLICT');
		const get = vi.fn().mockResolvedValue(snapshot(4, ['a', 'b']));
		const update = vi.fn().mockRejectedValue(conflict);
		const store = new PreamblesStore({ get, update });
		store.applySnapshot(snapshot(3, ['a']));

		await expect(
			store.update(
				'a',
				{
					enabled: true,
					title: 'Edited preamble a',
					content: 'Edited content a',
					scope: { type: 'global' },
				},
				3,
			),
		).rejects.toBe(conflict);

		expect(update).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 3 }));
		expect(get).toHaveBeenCalledOnce();
		expect(store.snapshot).toEqual(snapshot(4, ['a', 'b']));
	});

	it('performs a post-conflict read after joining an in-flight refresh', async () => {
		const conflict = new ApiError(409, 'revision conflict', 'PREAMBLE_REVISION_CONFLICT');
		const resolvers: Array<(value: PreamblesSnapshot) => void> = [];
		const get = vi.fn(() => new Promise<PreamblesSnapshot>((resolve) => resolvers.push(resolve)));
		const update = vi.fn().mockRejectedValue(conflict);
		const store = new PreamblesStore({ get, update });
		store.applySnapshot(snapshot(3, ['a']));
		const refreshing = store.refresh();

		const updating = store.update(
			'a',
			{
				enabled: true,
				title: 'Edited preamble a',
				content: 'Edited content a',
				scope: { type: 'global' },
			},
			3,
		);
		await vi.waitFor(() => expect(update).toHaveBeenCalledOnce());
		resolvers[0]!(snapshot(3, ['a']));
		await refreshing;
		await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(2));
		resolvers[1]!(snapshot(4, ['a', 'b']));

		await expect(updating).rejects.toBe(conflict);
		expect(store.snapshot).toEqual(snapshot(4, ['a', 'b']));
	});

	it('performs a post-conflict read after a joined refresh fails', async () => {
		const conflict = new ApiError(409, 'revision conflict', 'PREAMBLE_REVISION_CONFLICT');
		let rejectRefresh!: (error: Error) => void;
		const refreshFailure = new Error('refresh unavailable');
		const get = vi
			.fn()
			.mockImplementationOnce(
				() =>
					new Promise<PreamblesSnapshot>((_resolve, reject) => {
						rejectRefresh = reject;
					}),
			)
			.mockResolvedValueOnce(snapshot(4, ['a', 'b']));
		const update = vi.fn().mockRejectedValue(conflict);
		const store = new PreamblesStore({ get, update });
		store.applySnapshot(snapshot(3, ['a']));
		const refreshing = store.refresh().catch((error) => error);

		const updating = store.update(
			'a',
			{
				enabled: true,
				title: 'Edited preamble a',
				content: 'Edited content a',
				scope: { type: 'global' },
			},
			3,
		);
		await vi.waitFor(() => expect(update).toHaveBeenCalledOnce());
		rejectRefresh(refreshFailure);

		expect(await refreshing).toBe(refreshFailure);
		await expect(updating).rejects.toBe(conflict);
		expect(get).toHaveBeenCalledTimes(2);
		expect(store.snapshot).toEqual(snapshot(4, ['a', 'b']));
	});

	it('retries when a conflict joins a failing refresh-loop load', async () => {
		const conflict = new ApiError(409, 'revision conflict', 'PREAMBLE_REVISION_CONFLICT');
		let rejectRefresh!: (error: Error) => void;
		const get = vi
			.fn()
			.mockImplementationOnce(
				() =>
					new Promise<PreamblesSnapshot>((_resolve, reject) => {
						rejectRefresh = reject;
					}),
			)
			.mockResolvedValueOnce(snapshot(4, ['a', 'b']));
		const update = vi.fn().mockRejectedValue(conflict);
		const store = new PreamblesStore({ get, update });
		store.applySnapshot(snapshot(3, ['a']));
		const refreshing = store.refreshIfLoaded();

		const updating = store.update(
			'a',
			{
				enabled: true,
				title: 'Edited preamble a',
				content: 'Edited content a',
				scope: { type: 'global' },
			},
			3,
		);
		await vi.waitFor(() => expect(update).toHaveBeenCalledOnce());
		rejectRefresh(new Error('refresh unavailable'));

		await refreshing;
		await expect(updating).rejects.toBe(conflict);
		expect(get).toHaveBeenCalledTimes(2);
		expect(store.snapshot).toEqual(snapshot(4, ['a', 'b']));
	});

	it('refreshes again when invalidated during an in-flight load', async () => {
		const resolvers: Array<(value: PreamblesSnapshot) => void> = [];
		const get = vi.fn(() => new Promise<PreamblesSnapshot>((resolve) => resolvers.push(resolve)));
		const store = new PreamblesStore({ get });
		store.applySnapshot(snapshot(1, ['a']));

		const first = store.refreshIfLoaded();
		const second = store.refreshIfLoaded();
		resolvers[0]!(snapshot(2, ['a']));
		await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(2));
		resolvers[1]!(snapshot(3, ['a', 'b']));
		await Promise.all([first, second]);

		expect(store.snapshot).toEqual(snapshot(3, ['a', 'b']));
	});

	it('does not replace a newer mutation snapshot with a stale read', () => {
		const store = new PreamblesStore();
		store.applySnapshot(snapshot(4, ['a', 'b']));
		store.applySnapshot(snapshot(3, ['a']));
		expect(store.snapshot).toEqual(snapshot(4, ['a', 'b']));
	});

	it('marks an already-loaded store refreshing and ineligible for local lookup during refresh', async () => {
		let resolveRead!: (value: PreamblesSnapshot) => void;
		const get = vi.fn(
			() =>
				new Promise<PreamblesSnapshot>((resolve) => {
					resolveRead = resolve;
				}),
		);
		const store = new PreamblesStore({ get });
		store.applySnapshot(snapshot(1, ['a']));
		expect(store.hasFreshSnapshot).toBe(true);

		const retrying = store.refresh();
		expect(store.status).toBe('ready');
		expect(store.isRefreshing).toBe(true);
		expect(store.hasFreshSnapshot).toBe(false);

		resolveRead(snapshot(2, ['a', 'b']));
		await retrying;
		expect(store.isRefreshing).toBe(false);
		expect(store.hasFreshSnapshot).toBe(true);
	});

	it('replaces the catalog immediately when an authoritative refresh returns a restored lower revision', async () => {
		const get = vi
			.fn()
			.mockResolvedValueOnce(snapshot(1, ['restored']))
			.mockResolvedValueOnce(snapshot(2, ['updated']));
		const store = new PreamblesStore({ get });
		store.applySnapshot(snapshot(3, ['a']));

		await store.refreshIfLoaded();
		expect(store.snapshot).toEqual(snapshot(1, ['restored']));
		expect(store.hasFreshSnapshot).toBe(true);

		await store.refreshIfLoaded();
		expect(store.snapshot).toEqual(snapshot(2, ['updated']));
		expect(store.hasFreshSnapshot).toBe(true);
	});

	it('ignores a stale GET overtaken by a mutation while applying a concurrent GET that saw a newer revision', async () => {
		let resolveStaleRead!: (value: PreamblesSnapshot) => void;
		let resolveNewerRead!: (value: PreamblesSnapshot) => void;
		const get = vi
			.fn()
			.mockImplementationOnce(
				() =>
					new Promise<PreamblesSnapshot>((resolve) => {
						resolveStaleRead = resolve;
					}),
			)
			.mockImplementationOnce(
				() =>
					new Promise<PreamblesSnapshot>((resolve) => {
						resolveNewerRead = resolve;
					}),
			);
		const create = vi
			.fn()
			.mockResolvedValueOnce({ success: true, snapshot: snapshot(2, ['a', 'b']) })
			.mockResolvedValueOnce({ success: true, snapshot: snapshot(3, ['a', 'b', 'c']) });
		const store = new PreamblesStore({ get, create });
		store.applySnapshot(snapshot(1, ['a']));

		const staleReading = store.refresh();
		await store.create({
			enabled: true,
			title: 'Preamble b',
			content: 'Content b',
			scope: { type: 'global' },
		});
		resolveStaleRead(snapshot(1, ['a']));
		await staleReading;

		expect(store.snapshot).toEqual(snapshot(2, ['a', 'b']));
		expect(store.hasFreshSnapshot).toBe(true);

		const newerReading = store.refresh();
		await store.create({
			enabled: true,
			title: 'Preamble c',
			content: 'Content c',
			scope: { type: 'global' },
		});
		resolveNewerRead(snapshot(4, ['a', 'b', 'c', 'd']));
		await newerReading;

		expect(store.snapshot).toEqual(snapshot(4, ['a', 'b', 'c', 'd']));
		expect(store.hasFreshSnapshot).toBe(true);
	});

	it('keeps local lookup ineligible across every microtask of a queued invalidation loop', async () => {
		const resolvers: Array<(value: PreamblesSnapshot) => void> = [];
		const get = vi.fn(() => new Promise<PreamblesSnapshot>((resolve) => resolvers.push(resolve)));
		const store = new PreamblesStore({ get });
		store.applySnapshot(snapshot(1, ['a']));

		const first = store.refreshIfLoaded();
		const second = store.refreshIfLoaded();
		const samples: boolean[] = [];
		resolvers[0]!(snapshot(2, ['a']));
		for (let step = 0; step < 32 && get.mock.calls.length < 2; step += 1) {
			samples.push(store.hasFreshSnapshot);
			await Promise.resolve();
		}
		expect(get).toHaveBeenCalledTimes(2);
		expect(samples.length).toBeGreaterThan(1);
		expect(samples).not.toContain(true);

		resolvers[1]!(snapshot(3, ['a', 'b']));
		await Promise.all([first, second]);
		expect(store.hasFreshSnapshot).toBe(true);
	});

	it.each([0, 1, 2])(
		'does not lose an invalidation queued %i microtask(s) after a joined GET settles',
		async (delayTicks) => {
			const resolvers: Array<(value: PreamblesSnapshot) => void> = [];
			const get = vi.fn(() => new Promise<PreamblesSnapshot>((resolve) => resolvers.push(resolve)));
			const store = new PreamblesStore({ get });
			store.applySnapshot(snapshot(1, ['a']));

			const first = store.refreshIfLoaded();
			let joined: Promise<unknown> = store.refresh();
			for (let tick = 0; tick < delayTicks; tick += 1) {
				joined = joined.then(() => undefined);
			}
			const second = joined.then(() => store.refreshIfLoaded());
			resolvers[0]!(snapshot(2, ['a']));
			await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(2));
			expect(store.hasFreshSnapshot).toBe(false);

			resolvers[1]!(snapshot(3, ['a', 'b']));
			await Promise.all([first, second]);
			expect(store.snapshot).toEqual(snapshot(3, ['a', 'b']));
			expect(store.hasFreshSnapshot).toBe(true);
		},
	);

	it('withholds delayed reorder or mutation results across reconnect and regression boundaries', async () => {
		let resolveReorder!: (value: { success: true; snapshot: PreamblesSnapshot }) => void;
		const reorder = vi.fn(
			() =>
				new Promise<{ success: true; snapshot: PreamblesSnapshot }>((resolve) => {
					resolveReorder = resolve;
				}),
		);
		const get = vi
			.fn()
			.mockResolvedValueOnce(snapshot(0, []))
			.mockResolvedValueOnce(snapshot(0, []));
		const store = new PreamblesStore({ get, reorder });
		store.applySnapshot(snapshot(3, ['a', 'b']));

		const moving = store.move('b', 'up');
		expect(reorder).toHaveBeenCalledOnce();
		await store.refreshIfLoaded();
		expect(store.snapshot).toEqual(snapshot(0, []));
		expect(store.hasFreshSnapshot).toBe(true);

		resolveReorder({ success: true, snapshot: snapshot(4, ['b', 'a']) });
		await moving;
		expect(get).toHaveBeenCalledTimes(2);
		expect(store.snapshot).toEqual(snapshot(0, []));
		expect(store.hasFreshSnapshot).toBe(true);

		// Same-revision reconnect restore (revision 3 -> restored revision 3) must also withhold delayed rev 4.
		let resolveSameRev!: (value: { success: true; snapshot: PreamblesSnapshot }) => void;
		const createSameRev = vi.fn(
			() =>
				new Promise<{ success: true; snapshot: PreamblesSnapshot }>((resolve) => {
					resolveSameRev = resolve;
				}),
		);
		const restoredGet = vi
			.fn()
			.mockResolvedValueOnce(snapshot(3, ['restored']))
			.mockResolvedValueOnce(snapshot(3, ['restored']));
		const reconnectStore = new PreamblesStore({ get: restoredGet, create: createSameRev });
		reconnectStore.applySnapshot(snapshot(3, ['original']));

		const creatingAcrossReconnect = reconnectStore.create({
			enabled: true,
			title: 'Stale preamble',
			content: 'Stale',
			scope: { type: 'global' },
		});
		expect(createSameRev).toHaveBeenCalledOnce();
		await reconnectStore.reconcileAfterReconnect();
		expect(reconnectStore.snapshot).toEqual(snapshot(3, ['restored']));

		resolveSameRev({ success: true, snapshot: snapshot(4, ['original', 'stale']) });
		expect(await creatingAcrossReconnect).toEqual(snapshot(3, ['restored']));
		expect(restoredGet).toHaveBeenCalledTimes(2);
		expect(reconnectStore.snapshot).toEqual(snapshot(3, ['restored']));
		expect(reconnectStore.hasFreshSnapshot).toBe(true);
	});

	it('retains an acknowledged deletion and preserves the read error while reconciliation retries', async () => {
		let resolveRemove!: (value: { success: true; snapshot: PreamblesSnapshot }) => void;
		const remove = vi.fn(
			() =>
				new Promise<{ success: true; snapshot: PreamblesSnapshot }>((resolve) => {
					resolveRemove = resolve;
				}),
		);
		let rejectRetry!: (error: Error) => void;
		const failingGet = vi
			.fn<() => Promise<PreamblesSnapshot>>()
			.mockRejectedValueOnce(new Error('offline'))
			.mockImplementationOnce(
				() =>
					new Promise<PreamblesSnapshot>((_resolve, reject) => {
						rejectRetry = reject;
					}),
			);
		const store = new PreamblesStore({ get: failingGet, remove });
		store.applySnapshot(snapshot(3, ['a', 'b']));

		const removing = store.remove('b');
		expect(remove).toHaveBeenCalledOnce();
		await store.refreshIfLoaded();
		expect(store.error).toBe('offline');
		expect(store.hasFreshSnapshot).toBe(false);

		resolveRemove({ success: true, snapshot: snapshot(4, ['a']) });
		await vi.waitFor(() => expect(failingGet).toHaveBeenCalledTimes(2));
		expect(store.snapshot).toEqual(snapshot(4, ['a']));
		expect(store.error).toBe('offline');
		expect(store.hasFreshSnapshot).toBe(false);

		rejectRetry(new Error('still offline'));
		expect(await removing).toEqual(snapshot(4, ['a']));
		expect(store.snapshot).toEqual(snapshot(4, ['a']));
		expect(store.error).toBe('still offline');
		expect(store.hasFreshSnapshot).toBe(false);
	});

	it('ignores a pre-reconnect GET so the queued reconnect GET establishes the restored catalog', async () => {
		const resolvers: Array<(value: PreamblesSnapshot) => void> = [];
		const get = vi.fn(() => new Promise<PreamblesSnapshot>((resolve) => resolvers.push(resolve)));
		const store = new PreamblesStore({ get });
		store.applySnapshot(snapshot(3, ['original']));

		const preReconnectRead = store.refresh();
		const reconnecting = store.reconcileAfterReconnect();
		resolvers[0]!(snapshot(4, ['stale-old-authority']));
		await preReconnectRead;

		await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(2));
		expect(store.snapshot).toEqual(snapshot(3, ['original']));
		expect(store.hasFreshSnapshot).toBe(false);

		resolvers[1]!(snapshot(3, ['restored']));
		await reconnecting;
		expect(store.snapshot).toEqual(snapshot(3, ['restored']));
		expect(store.hasFreshSnapshot).toBe(true);
	});

	it('ignores a pre-reconnect initial GET without a retained snapshot until reconnect GET finishes', async () => {
		const resolvers: Array<(value: PreamblesSnapshot) => void> = [];
		const get = vi.fn(() => new Promise<PreamblesSnapshot>((resolve) => resolvers.push(resolve)));
		const store = new PreamblesStore({ get });

		const initialLoad = store.ensureLoaded();
		const reconnecting = store.reconcileAfterReconnect();
		resolvers[0]!(snapshot(4, ['stale-old-authority']));

		await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(2));
		expect(store.snapshot).toBeNull();
		expect(store.status).toBe('loading');
		expect(store.hasFreshSnapshot).toBe(false);

		resolvers[1]!(snapshot(3, ['restored']));
		expect(await initialLoad).toEqual(snapshot(3, ['restored']));
		await reconnecting;
		expect(store.snapshot).toEqual(snapshot(3, ['restored']));
		expect(store.status).toBe('ready');
		expect(store.hasFreshSnapshot).toBe(true);
	});

	it('delivers the post-reconnect GET outcome to all concurrent initial ensureLoaded callers when the pre-reconnect GET rejects', async () => {
		const deferreds: Array<{
			resolve: (value: PreamblesSnapshot) => void;
			reject: (error: Error) => void;
		}> = [];
		const get = vi.fn(
			() =>
				new Promise<PreamblesSnapshot>((resolve, reject) => {
					deferreds.push({ resolve, reject });
				}),
		);
		const store = new PreamblesStore({ get });

		const first = store.ensureLoaded();
		const second = store.ensureLoaded();
		const reconnecting = store.reconcileAfterReconnect();
		const third = store.ensureLoaded();

		deferreds[0]!.reject(new Error('stale socket reset'));
		await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(2));
		expect(store.snapshot).toBeNull();
		expect(store.status).toBe('loading');

		deferreds[1]!.resolve(snapshot(3, ['restored']));
		expect(await Promise.all([first, second, third])).toEqual([
			snapshot(3, ['restored']),
			snapshot(3, ['restored']),
			snapshot(3, ['restored']),
		]);
		await reconnecting;
		expect(get).toHaveBeenCalledTimes(2);
		expect(store.hasFreshSnapshot).toBe(true);

		// When the post-reconnect GET also fails, all callers observe the new failure.
		const failureDeferreds: Array<{
			resolve: (value: PreamblesSnapshot) => void;
			reject: (error: Error) => void;
		}> = [];
		const failingGet = vi.fn(
			() =>
				new Promise<PreamblesSnapshot>((resolve, reject) => {
					failureDeferreds.push({ resolve, reject });
				}),
		);
		const failingStore = new PreamblesStore({ get: failingGet });
		const f1 = failingStore.ensureLoaded();
		const f2 = failingStore.ensureLoaded();
		const fReconnect = failingStore.reconcileAfterReconnect();
		const f3 = failingStore.ensureLoaded();

		const newFailure = new Error('post-reconnect failure');
		const outcomes = Promise.allSettled([f1, f2, f3]);
		failureDeferreds[0]!.reject(new Error('stale socket reset'));
		await vi.waitFor(() => expect(failingGet).toHaveBeenCalledTimes(2));
		failureDeferreds[1]!.reject(newFailure);
		expect(await outcomes).toEqual([
			{ status: 'rejected', reason: newFailure },
			{ status: 'rejected', reason: newFailure },
			{ status: 'rejected', reason: newFailure },
		]);
		await fReconnect;
		expect(failingGet).toHaveBeenCalledTimes(2);
		expect(failingStore.status).toBe('error');
		expect(failingStore.error).toBe('post-reconnect failure');
	});

	it('rolls back an optimistic move and queues a post-ack GET when ack lands during an in-flight reconnect GET', async () => {
		const getResolvers: Array<(value: PreamblesSnapshot) => void> = [];
		const get = vi.fn(
			() => new Promise<PreamblesSnapshot>((resolve) => getResolvers.push(resolve)),
		);
		let resolveReorder!: (value: { success: true; snapshot: PreamblesSnapshot }) => void;
		const reorder = vi.fn(
			() =>
				new Promise<{ success: true; snapshot: PreamblesSnapshot }>((resolve) => {
					resolveReorder = resolve;
				}),
		);
		const store = new PreamblesStore({ get, reorder });
		store.applySnapshot(snapshot(3, ['a', 'b']));

		const moving = store.move('b', 'up');
		expect(reorder).toHaveBeenCalledOnce();
		expect(store.preambles.map((entry) => entry.id)).toEqual(['b', 'a']);

		const reconnecting = store.reconcileAfterReconnect();
		await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1));

		resolveReorder({ success: true, snapshot: snapshot(4, ['b', 'a']) });
		await vi.waitFor(() =>
			expect(store.preambles.map((entry) => entry.id)).toEqual(['a', 'b']),
		);

		getResolvers[0]!(snapshot(3, ['a', 'b']));
		await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(2));
		getResolvers[1]!(snapshot(4, ['a', 'b']));
		await Promise.all([moving, reconnecting]);
		expect(store.preambles.map((entry) => entry.id)).toEqual(['a', 'b']);
		expect(store.hasFreshSnapshot).toBe(true);
	});

	it('treats a changed same-revision confirmed GET as a reset without misclassifying optimistic moves', async () => {
		// Optimistic move + pre-move same-revision GET must not falsely trigger a reset.
		let resolveNormalMove!: (value: { success: true; snapshot: PreamblesSnapshot }) => void;
		const reorderNormal = vi.fn(
			() =>
				new Promise<{ success: true; snapshot: PreamblesSnapshot }>((resolve) => {
					resolveNormalMove = resolve;
				}),
		);
		const getPreMove = vi.fn<() => Promise<PreamblesSnapshot>>().mockResolvedValueOnce(snapshot(3, ['a', 'b']));
		const normalStore = new PreamblesStore({ get: getPreMove, reorder: reorderNormal });
		normalStore.applySnapshot(snapshot(3, ['a', 'b']));

		const normalMove = normalStore.move('b', 'up');
		await normalStore.refreshIfLoaded();
		resolveNormalMove({ success: true, snapshot: snapshot(4, ['b', 'a']) });
		await normalMove;
		expect(getPreMove).toHaveBeenCalledTimes(1);
		expect(normalStore.snapshot).toEqual(snapshot(4, ['b', 'a']));
		expect(normalStore.hasFreshSnapshot).toBe(true);

		// A restored same-revision GET with different confirmed entries must advance reset and withhold delayed ack.
		let resolveRestoredRemove!: (value: { success: true; snapshot: PreamblesSnapshot }) => void;
		const remove = vi.fn(
			() =>
				new Promise<{ success: true; snapshot: PreamblesSnapshot }>((resolve) => {
					resolveRestoredRemove = resolve;
				}),
		);
		const getRestored = vi
			.fn<() => Promise<PreamblesSnapshot>>()
			.mockResolvedValueOnce(snapshot(3, ['c']))
			.mockResolvedValueOnce(snapshot(3, ['c']));
		const restoredStore = new PreamblesStore({ get: getRestored, remove });
		restoredStore.applySnapshot(snapshot(3, ['a', 'b']));

		const removing = restoredStore.remove('b');
		await restoredStore.refreshIfLoaded();
		expect(restoredStore.snapshot).toEqual(snapshot(3, ['c']));

		resolveRestoredRemove({ success: true, snapshot: snapshot(4, ['a']) });
		expect(await removing).toEqual(snapshot(3, ['c']));
		expect(getRestored).toHaveBeenCalledTimes(2);
		expect(restoredStore.snapshot).toEqual(snapshot(3, ['c']));
		expect(restoredStore.hasFreshSnapshot).toBe(true);
	});

	it('reconciles overlapping read failures and mutations regardless of completion order or stale ack revision', async () => {
		// Case 1: mutation ack lands first, then the overlapping GET rejects.
		let rejectFirstRead!: (error: Error) => void;
		let resolveFollowUp!: (value: PreamblesSnapshot) => void;
		const get = vi
			.fn<() => Promise<PreamblesSnapshot>>()
			.mockImplementationOnce(
				() =>
					new Promise<PreamblesSnapshot>((_resolve, reject) => {
						rejectFirstRead = reject;
					}),
			)
			.mockImplementationOnce(
				() =>
					new Promise<PreamblesSnapshot>((resolve) => {
						resolveFollowUp = resolve;
					}),
			);
		const create = vi.fn().mockResolvedValueOnce({ success: true, snapshot: snapshot(4, ['a', 'b']) });
		const store = new PreamblesStore({ get, create });
		store.applySnapshot(snapshot(3, ['a']));

		const reading = store.refresh().catch((error) => error);
		await store.create({
			enabled: true,
			title: 'Preamble b',
			content: 'Content b',
			scope: { type: 'global' },
		});
		expect(store.snapshot).toEqual(snapshot(4, ['a', 'b']));

		const readFailure = new Error('offline');
		rejectFirstRead(readFailure);
		expect(await reading).toBe(readFailure);
		await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(2));
		expect(store.snapshot).toEqual(snapshot(4, ['a', 'b']));
		expect(store.error).toBe('offline');
		expect(store.hasFreshSnapshot).toBe(false);

		resolveFollowUp(snapshot(4, ['a', 'b']));
		await vi.waitFor(() => expect(store.hasFreshSnapshot).toBe(true));
		expect(store.error).toBeNull();

		// Case 2: older mutation ack lands after a read failure when a newer snapshot is already retained.
		let resolveOlderMutation!: (value: { success: true; snapshot: PreamblesSnapshot }) => void;
		let resolveNewerMutation!: (value: { success: true; snapshot: PreamblesSnapshot }) => void;
		let resolveReconcile!: (value: PreamblesSnapshot) => void;
		const get2 = vi
			.fn<() => Promise<PreamblesSnapshot>>()
			.mockRejectedValueOnce(new Error('offline'))
			.mockRejectedValueOnce(new Error('still offline'))
			.mockImplementationOnce(
				() =>
					new Promise<PreamblesSnapshot>((resolve) => {
						resolveReconcile = resolve;
					}),
			);
		const create2 = vi
			.fn()
			.mockImplementationOnce(
				() =>
					new Promise<{ success: true; snapshot: PreamblesSnapshot }>((resolve) => {
						resolveOlderMutation = resolve;
					}),
			)
			.mockImplementationOnce(
				() =>
					new Promise<{ success: true; snapshot: PreamblesSnapshot }>((resolve) => {
						resolveNewerMutation = resolve;
					}),
			);
		const store2 = new PreamblesStore({ get: get2, create: create2 });
		store2.applySnapshot(snapshot(3, ['a']));

		const older = store2.create({
			enabled: true,
			title: 'Preamble b',
			content: 'Content b',
			scope: { type: 'global' },
		});
		const newer = store2.create({
			enabled: true,
			title: 'Preamble c',
			content: 'Content c',
			scope: { type: 'global' },
		});
		await store2.refreshIfLoaded();
		expect(store2.error).toBe('offline');

		resolveNewerMutation({ success: true, snapshot: snapshot(5, ['a', 'b', 'c']) });
		await newer;
		expect(store2.snapshot).toEqual(snapshot(5, ['a', 'b', 'c']));
		expect(store2.error).toBe('still offline');

		resolveOlderMutation({ success: true, snapshot: snapshot(4, ['a', 'b']) });
		await vi.waitFor(() => expect(get2).toHaveBeenCalledTimes(3));
		expect(store2.snapshot).toEqual(snapshot(5, ['a', 'b', 'c']));
		expect(store2.error).toBe('still offline');
		expect(store2.hasFreshSnapshot).toBe(false);

		resolveReconcile(snapshot(5, ['a', 'b', 'c']));
		expect(await older).toEqual(snapshot(5, ['a', 'b', 'c']));
		expect(store2.error).toBeNull();
		expect(store2.hasFreshSnapshot).toBe(true);

		// Case 3: stale mutation ack arrives BEFORE an overlapping GET rejects.
		let resolveDelayedAck!: (value: { success: true; snapshot: PreamblesSnapshot }) => void;
		let rejectOutstanding!: (error: Error) => void;
		let resolveAfterStaleAck!: (value: PreamblesSnapshot) => void;
		const get3 = vi
			.fn<() => Promise<PreamblesSnapshot>>()
			.mockResolvedValueOnce(snapshot(5, ['a', 'b', 'c']))
			.mockImplementationOnce(
				() =>
					new Promise<PreamblesSnapshot>((_resolve, reject) => {
						rejectOutstanding = reject;
					}),
			)
			.mockImplementationOnce(
				() =>
					new Promise<PreamblesSnapshot>((resolve) => {
						resolveAfterStaleAck = resolve;
					}),
			);
		const create3 = vi.fn(
			() =>
				new Promise<{ success: true; snapshot: PreamblesSnapshot }>((resolve) => {
					resolveDelayedAck = resolve;
				}),
		);
		const store3 = new PreamblesStore({ get: get3, create: create3 });
		store3.applySnapshot(snapshot(3, ['a']));

		const delayedCreate = store3.create({
			enabled: true,
			title: 'Preamble b',
			content: 'Content b',
			scope: { type: 'global' },
		});
		await store3.refreshIfLoaded();
		expect(store3.snapshot).toEqual(snapshot(5, ['a', 'b', 'c']));

		const outstandingRead = store3.refresh().catch((error) => error);
		resolveDelayedAck({ success: true, snapshot: snapshot(4, ['a', 'b']) });
		expect(await delayedCreate).toEqual(snapshot(5, ['a', 'b', 'c']));

		const failure = new Error('transient');
		rejectOutstanding(failure);
		expect(await outstandingRead).toBe(failure);
		await vi.waitFor(() => expect(get3).toHaveBeenCalledTimes(3));
		expect(store3.snapshot).toEqual(snapshot(5, ['a', 'b', 'c']));
		expect(store3.error).toBe('transient');
		expect(store3.hasFreshSnapshot).toBe(false);

		resolveAfterStaleAck(snapshot(5, ['a', 'b', 'c']));
		await vi.waitFor(() => expect(store3.hasFreshSnapshot).toBe(true));
		expect(store3.error).toBeNull();
	});

	it('retains a conflicting same-revision authoritative GET and reconciles when a delayed ack disagrees', async () => {
		let resolveRemove!: (value: { success: true; snapshot: PreamblesSnapshot }) => void;
		const remove = vi.fn(
			() =>
				new Promise<{ success: true; snapshot: PreamblesSnapshot }>((resolve) => {
					resolveRemove = resolve;
				}),
		);
		const get = vi
			.fn<() => Promise<PreamblesSnapshot>>()
			.mockResolvedValueOnce(snapshot(4, ['restored']))
			.mockResolvedValueOnce(snapshot(4, ['restored']));
		const store = new PreamblesStore({ get, remove });
		store.applySnapshot(snapshot(3, ['a', 'b']));

		const removing = store.remove('b');
		await store.refreshIfLoaded();
		expect(store.snapshot).toEqual(snapshot(4, ['restored']));

		resolveRemove({ success: true, snapshot: snapshot(4, ['a']) });
		expect(await removing).toEqual(snapshot(4, ['restored']));
		expect(get).toHaveBeenCalledTimes(2);
		expect(store.snapshot).toEqual(snapshot(4, ['restored']));
		expect(store.hasFreshSnapshot).toBe(true);
	});
});
