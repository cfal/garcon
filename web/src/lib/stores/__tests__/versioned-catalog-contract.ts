import { describe, expect, it, vi } from 'vitest';
import type { VersionedCatalogSnapshot, VersionedCatalogStatus } from '../versioned-catalog-store.svelte.js';

export interface VersionedCatalogContractStore<Snapshot extends VersionedCatalogSnapshot> {
	readonly status: VersionedCatalogStatus;
	readonly snapshot: Snapshot | null;
	readonly error: string | null;
	readonly isRefreshing: boolean;
	readonly hasFreshSnapshot: boolean;
	ensureLoaded(): Promise<Snapshot>;
	refresh(): Promise<Snapshot>;
	refreshIfLoaded(): Promise<void>;
	reconcileAfterReconnect(): Promise<void>;
	applySnapshot(next: Snapshot): Snapshot;
}

export interface VersionedCatalogContractAdapter<
	Snapshot extends VersionedCatalogSnapshot,
	Store extends VersionedCatalogContractStore<Snapshot>,
> {
	snapshot(revision: number, ids: string[]): Snapshot;
	createStore(deps: {
		get?: () => Promise<Snapshot>;
		create?: () => Promise<{ success: true; snapshot: Snapshot }>;
		remove?: () => Promise<{ success: true; snapshot: Snapshot }>;
	}): Store;
	createItem(store: Store, id: string): Promise<Snapshot>;
	removeItem(store: Store, id: string): Promise<Snapshot>;
}

function deferredQueue<T>() {
	const items: Array<PromiseWithResolvers<T>> = [];
	const fn = vi.fn(() => {
		const next = Promise.withResolvers<T>();
		items.push(next);
		return next.promise;
	});
	return { fn, items };
}

export function describeVersionedCatalogConcurrencyContract<
	Snapshot extends VersionedCatalogSnapshot,
	Store extends VersionedCatalogContractStore<Snapshot>,
>(
	name: string,
	adapter: VersionedCatalogContractAdapter<Snapshot, Store>,
): void {
	const { snapshot, createStore, createItem, removeItem } = adapter;

	describe(`${name} concurrency contract`, () => {
		it('marks an already-loaded store refreshing and ineligible for local lookup while a retry GET is in flight', async () => {
			const read = Promise.withResolvers<Snapshot>();
			const store = createStore({ get: vi.fn(() => read.promise) });
			store.applySnapshot(snapshot(1, ['a']));
			expect(store.hasFreshSnapshot).toBe(true);

			const retrying = store.refresh();
			expect(store.status).toBe('ready');
			expect(store.isRefreshing).toBe(true);
			expect(store.hasFreshSnapshot).toBe(false);

			read.resolve(snapshot(2, ['a', 'b']));
			await retrying;
			expect(store.isRefreshing).toBe(false);
			expect(store.hasFreshSnapshot).toBe(true);
			expect(store.snapshot).toEqual(snapshot(2, ['a', 'b']));
		});

		it('replaces the catalog immediately when an authoritative refresh returns a restored lower revision', async () => {
			const get = vi
				.fn<() => Promise<Snapshot>>()
				.mockReturnValueOnce(Promise.resolve(snapshot(1, ['restored'])))
				.mockReturnValueOnce(Promise.resolve(snapshot(2, ['updated'])));
			const store = createStore({ get });
			store.applySnapshot(snapshot(3, ['probe']));
			expect(store.hasFreshSnapshot).toBe(true);

			await store.refreshIfLoaded();
			expect(store.snapshot).toEqual(snapshot(1, ['restored']));
			expect(store.hasFreshSnapshot).toBe(true);

			await store.refreshIfLoaded();
			expect(store.snapshot).toEqual(snapshot(2, ['updated']));
			expect(store.hasFreshSnapshot).toBe(true);
		});

		it('ignores a stale GET overtaken by a mutation while applying a concurrent GET that saw a newer revision', async () => {
			const staleRead = Promise.withResolvers<Snapshot>();
			const newerRead = Promise.withResolvers<Snapshot>();
			const get = vi
				.fn<() => Promise<Snapshot>>()
				.mockReturnValueOnce(staleRead.promise)
				.mockReturnValueOnce(newerRead.promise);
			const create = vi
				.fn<() => Promise<{ success: true; snapshot: Snapshot }>>()
				.mockResolvedValueOnce({ success: true, snapshot: snapshot(2, ['a', 'b']) })
				.mockResolvedValueOnce({ success: true, snapshot: snapshot(3, ['a', 'b', 'c']) });
			const store = createStore({ get, create });
			store.applySnapshot(snapshot(1, ['a']));

			const staleReading = store.refresh();
			expect(store.hasFreshSnapshot).toBe(false);
			await createItem(store, 'b');
			expect(store.snapshot).toEqual(snapshot(2, ['a', 'b']));

			staleRead.resolve(snapshot(1, ['a']));
			await staleReading;
			expect(store.snapshot).toEqual(snapshot(2, ['a', 'b']));
			expect(store.hasFreshSnapshot).toBe(true);

			const newerReading = store.refresh();
			await createItem(store, 'c');
			expect(store.snapshot).toEqual(snapshot(3, ['a', 'b', 'c']));
			newerRead.resolve(snapshot(4, ['a', 'b', 'c', 'd']));
			await newerReading;
			expect(store.snapshot).toEqual(snapshot(4, ['a', 'b', 'c', 'd']));
			expect(store.hasFreshSnapshot).toBe(true);
		});

		it('keeps local lookup ineligible across every microtask of a queued invalidation loop', async () => {
			const reads = deferredQueue<Snapshot>();
			const store = createStore({ get: reads.fn });
			store.applySnapshot(snapshot(1, ['a']));

			const first = store.refreshIfLoaded();
			const second = store.refreshIfLoaded();
			expect(store.hasFreshSnapshot).toBe(false);

			const samples: boolean[] = [];
			reads.items[0]!.resolve(snapshot(2, ['a']));
			for (let step = 0; step < 32 && reads.fn.mock.calls.length < 2; step += 1) {
				samples.push(store.hasFreshSnapshot);
				await Promise.resolve();
			}
			expect(reads.fn).toHaveBeenCalledTimes(2);
			expect(samples.length).toBeGreaterThan(1);
			expect(samples).not.toContain(true);

			reads.items[1]!.resolve(snapshot(3, ['a', 'b']));
			await Promise.all([first, second]);
			expect(store.hasFreshSnapshot).toBe(true);
		});

		it.each([0, 1, 2])(
			'does not lose an invalidation queued %i microtask(s) after a joined GET settles',
			async (delayTicks) => {
				const reads = deferredQueue<Snapshot>();
				const store = createStore({ get: reads.fn });
				store.applySnapshot(snapshot(1, ['a']));

				const first = store.refreshIfLoaded();
				let joined: Promise<unknown> = store.refresh();
				for (let tick = 0; tick < delayTicks; tick += 1) {
					joined = joined.then(() => undefined);
				}
				const second = joined.then(() => store.refreshIfLoaded());
				reads.items[0]!.resolve(snapshot(2, ['a']));
				await vi.waitFor(() => expect(reads.fn).toHaveBeenCalledTimes(2));
				expect(store.hasFreshSnapshot).toBe(false);

				reads.items[1]!.resolve(snapshot(3, ['a', 'b']));
				await Promise.all([first, second]);
				expect(store.snapshot).toEqual(snapshot(3, ['a', 'b']));
				expect(store.hasFreshSnapshot).toBe(true);
			},
		);

		it('withholds delayed mutation results across a lower-revision restore boundary', async () => {
			const mutation = Promise.withResolvers<{ success: true; snapshot: Snapshot }>();
			const create = vi.fn(() => mutation.promise);
			const get = vi
				.fn<() => Promise<Snapshot>>()
				.mockReturnValueOnce(Promise.resolve(snapshot(0, [])))
				.mockReturnValueOnce(Promise.resolve(snapshot(0, [])));
			const store = createStore({ get, create });
			store.applySnapshot(snapshot(3, ['probe']));

			const creating = createItem(store, 'b');
			expect(create).toHaveBeenCalledOnce();
			await store.refreshIfLoaded();
			expect(store.snapshot).toEqual(snapshot(0, []));
			expect(store.hasFreshSnapshot).toBe(true);

			mutation.resolve({ success: true, snapshot: snapshot(4, ['probe', 'b']) });
			expect(await creating).toEqual(snapshot(0, []));
			expect(get).toHaveBeenCalledTimes(2);
			expect(store.snapshot).toEqual(snapshot(0, []));
			expect(store.hasFreshSnapshot).toBe(true);
		});

		it('withholds delayed mutation results across a same-revision reconnect restore', async () => {
			const mutation = Promise.withResolvers<{ success: true; snapshot: Snapshot }>();
			const create = vi.fn(() => mutation.promise);
			const get = vi
				.fn<() => Promise<Snapshot>>()
				.mockReturnValueOnce(Promise.resolve(snapshot(3, ['restored'])))
				.mockReturnValueOnce(Promise.resolve(snapshot(3, ['restored'])));
			const store = createStore({ get, create });
			store.applySnapshot(snapshot(3, ['original']));

			const creating = createItem(store, 'stale');
			expect(create).toHaveBeenCalledOnce();
			await store.reconcileAfterReconnect();
			expect(store.snapshot).toEqual(snapshot(3, ['restored']));

			mutation.resolve({ success: true, snapshot: snapshot(4, ['original', 'stale']) });
			expect(await creating).toEqual(snapshot(3, ['restored']));
			expect(get).toHaveBeenCalledTimes(2);
			expect(store.snapshot).toEqual(snapshot(3, ['restored']));
			expect(store.hasFreshSnapshot).toBe(true);
		});

		it('withholds a delayed mutation when an ordinary GET returns a different same-revision catalog', async () => {
			const removal = Promise.withResolvers<{ success: true; snapshot: Snapshot }>();
			const remove = vi.fn(() => removal.promise);
			const get = vi
				.fn<() => Promise<Snapshot>>()
				.mockReturnValueOnce(Promise.resolve(snapshot(3, ['c'])))
				.mockReturnValueOnce(Promise.resolve(snapshot(3, ['c'])));
			const store = createStore({ get, remove });
			store.applySnapshot(snapshot(3, ['a', 'b']));

			const removing = removeItem(store, 'b');
			expect(remove).toHaveBeenCalledOnce();
			await store.refreshIfLoaded();
			expect(store.snapshot).toEqual(snapshot(3, ['c']));

			removal.resolve({ success: true, snapshot: snapshot(4, ['a']) });
			expect(await removing).toEqual(snapshot(3, ['c']));
			expect(get).toHaveBeenCalledTimes(2);
			expect(store.snapshot).toEqual(snapshot(3, ['c']));
			expect(store.hasFreshSnapshot).toBe(true);
		});

		it('retains a conflicting same-revision authoritative GET and reconciles when a delayed ack disagrees', async () => {
			const removal = Promise.withResolvers<{ success: true; snapshot: Snapshot }>();
			const remove = vi.fn(() => removal.promise);
			const get = vi
				.fn<() => Promise<Snapshot>>()
				.mockReturnValueOnce(Promise.resolve(snapshot(4, ['restored'])))
				.mockReturnValueOnce(Promise.resolve(snapshot(4, ['restored'])));
			const store = createStore({ get, remove });
			store.applySnapshot(snapshot(3, ['a', 'b']));

			const removing = removeItem(store, 'b');
			await store.refreshIfLoaded();
			expect(store.snapshot).toEqual(snapshot(4, ['restored']));

			removal.resolve({ success: true, snapshot: snapshot(4, ['a']) });
			expect(await removing).toEqual(snapshot(4, ['restored']));
			expect(get).toHaveBeenCalledTimes(2);
			expect(store.snapshot).toEqual(snapshot(4, ['restored']));
			expect(store.hasFreshSnapshot).toBe(true);
		});

		it('retains an acknowledged deletion and preserves the read error while reconciliation retries', async () => {
			const removal = Promise.withResolvers<{ success: true; snapshot: Snapshot }>();
			const remove = vi.fn(() => removal.promise);
			const retry = Promise.withResolvers<Snapshot>();
			const get = vi
				.fn<() => Promise<Snapshot>>()
				.mockRejectedValueOnce(new Error('offline'))
				.mockReturnValueOnce(retry.promise);
			const store = createStore({ get, remove });
			store.applySnapshot(snapshot(3, ['a', 'b']));

			const removing = removeItem(store, 'b');
			expect(remove).toHaveBeenCalledOnce();
			await store.refreshIfLoaded();
			expect(store.error).toBe('offline');
			expect(store.hasFreshSnapshot).toBe(false);

			removal.resolve({ success: true, snapshot: snapshot(4, ['a']) });
			await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(2));
			expect(store.snapshot).toEqual(snapshot(4, ['a']));
			expect(store.error).toBe('offline');
			expect(store.hasFreshSnapshot).toBe(false);

			retry.reject(new Error('still offline'));
			expect(await removing).toEqual(snapshot(4, ['a']));
			expect(store.snapshot).toEqual(snapshot(4, ['a']));
			expect(store.error).toBe('still offline');
			expect(store.hasFreshSnapshot).toBe(false);
		});

		it('ignores a pre-reconnect GET so the queued reconnect GET establishes the restored catalog', async () => {
			const reads = deferredQueue<Snapshot>();
			const store = createStore({ get: reads.fn });
			store.applySnapshot(snapshot(3, ['original']));

			const preReconnectRead = store.refresh();
			const reconnecting = store.reconcileAfterReconnect();
			reads.items[0]!.resolve(snapshot(4, ['stale-old-authority']));
			await preReconnectRead;

			await vi.waitFor(() => expect(reads.fn).toHaveBeenCalledTimes(2));
			expect(store.snapshot).toEqual(snapshot(3, ['original']));
			expect(store.hasFreshSnapshot).toBe(false);

			reads.items[1]!.resolve(snapshot(3, ['restored']));
			await reconnecting;
			expect(store.snapshot).toEqual(snapshot(3, ['restored']));
			expect(store.hasFreshSnapshot).toBe(true);
		});

		it('ignores a pre-reconnect initial GET without a retained snapshot until reconnect GET finishes', async () => {
			const reads = deferredQueue<Snapshot>();
			const store = createStore({ get: reads.fn });

			const initialLoad = store.ensureLoaded();
			const reconnecting = store.reconcileAfterReconnect();
			reads.items[0]!.resolve(snapshot(4, ['stale-old-authority']));

			await vi.waitFor(() => expect(reads.fn).toHaveBeenCalledTimes(2));
			expect(store.snapshot).toBeNull();
			expect(store.status).toBe('loading');
			expect(store.hasFreshSnapshot).toBe(false);

			reads.items[1]!.resolve(snapshot(3, ['restored']));
			expect(await initialLoad).toEqual(snapshot(3, ['restored']));
			await reconnecting;
			expect(store.snapshot).toEqual(snapshot(3, ['restored']));
			expect(store.status).toBe('ready');
			expect(store.hasFreshSnapshot).toBe(true);
		});

		it('delivers the post-reconnect GET snapshot to all concurrent initial ensureLoaded callers when the pre-reconnect GET rejects', async () => {
			const reads = deferredQueue<Snapshot>();
			const store = createStore({ get: reads.fn });

			const first = store.ensureLoaded();
			const second = store.ensureLoaded();
			const reconnecting = store.reconcileAfterReconnect();
			const third = store.ensureLoaded();

			reads.items[0]!.reject(new Error('stale socket reset'));
			await vi.waitFor(() => expect(reads.fn).toHaveBeenCalledTimes(2));
			expect(store.snapshot).toBeNull();
			expect(store.status).toBe('loading');

			reads.items[1]!.resolve(snapshot(3, ['restored']));
			expect(await Promise.all([first, second, third])).toEqual([
				snapshot(3, ['restored']),
				snapshot(3, ['restored']),
				snapshot(3, ['restored']),
			]);
			await reconnecting;
			expect(reads.fn).toHaveBeenCalledTimes(2);
			expect(store.hasFreshSnapshot).toBe(true);
		});

		it('delivers the post-reconnect GET failure to all concurrent initial ensureLoaded callers when both GETs reject', async () => {
			const reads = deferredQueue<Snapshot>();
			const store = createStore({ get: reads.fn });

			const first = store.ensureLoaded();
			const second = store.ensureLoaded();
			const reconnecting = store.reconcileAfterReconnect();
			const third = store.ensureLoaded();

			const newFailure = new Error('post-reconnect failure');
			const outcomes = Promise.allSettled([first, second, third]);
			reads.items[0]!.reject(new Error('stale socket reset'));
			await vi.waitFor(() => expect(reads.fn).toHaveBeenCalledTimes(2));
			reads.items[1]!.reject(newFailure);

			expect(await outcomes).toEqual([
				{ status: 'rejected', reason: newFailure },
				{ status: 'rejected', reason: newFailure },
				{ status: 'rejected', reason: newFailure },
			]);
			await reconnecting;
			expect(reads.fn).toHaveBeenCalledTimes(2);
			expect(store.status).toBe('error');
			expect(store.error).toBe('post-reconnect failure');
		});

		it('reconciles when a mutation ack lands before an overlapping GET rejects', async () => {
			const firstRead = Promise.withResolvers<Snapshot>();
			const followUp = Promise.withResolvers<Snapshot>();
			const get = vi
				.fn<() => Promise<Snapshot>>()
				.mockReturnValueOnce(firstRead.promise)
				.mockReturnValueOnce(followUp.promise);
			const create = vi
				.fn<() => Promise<{ success: true; snapshot: Snapshot }>>()
				.mockResolvedValueOnce({ success: true, snapshot: snapshot(4, ['a', 'b']) });
			const store = createStore({ get, create });
			store.applySnapshot(snapshot(3, ['a']));

			const reading = store.refresh().catch((error) => error);
			await createItem(store, 'b');
			expect(store.snapshot).toEqual(snapshot(4, ['a', 'b']));

			const readFailure = new Error('offline');
			firstRead.reject(readFailure);
			expect(await reading).toBe(readFailure);
			await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(2));
			expect(store.snapshot).toEqual(snapshot(4, ['a', 'b']));
			expect(store.error).toBe('offline');
			expect(store.hasFreshSnapshot).toBe(false);

			followUp.resolve(snapshot(4, ['a', 'b']));
			await vi.waitFor(() => expect(store.hasFreshSnapshot).toBe(true));
			expect(store.error).toBeNull();
		});

		it('reconciles when an older mutation ack lands after a read failure with a newer snapshot retained', async () => {
			const olderMutation = Promise.withResolvers<{ success: true; snapshot: Snapshot }>();
			const newerMutation = Promise.withResolvers<{ success: true; snapshot: Snapshot }>();
			const reconcile = Promise.withResolvers<Snapshot>();
			const get = vi
				.fn<() => Promise<Snapshot>>()
				.mockRejectedValueOnce(new Error('offline'))
				.mockRejectedValueOnce(new Error('still offline'))
				.mockReturnValueOnce(reconcile.promise);
			const create = vi
				.fn<() => Promise<{ success: true; snapshot: Snapshot }>>()
				.mockReturnValueOnce(olderMutation.promise)
				.mockReturnValueOnce(newerMutation.promise);
			const store = createStore({ get, create });
			store.applySnapshot(snapshot(3, ['a']));

			const older = createItem(store, 'b');
			const newer = createItem(store, 'c');
			await store.refreshIfLoaded();
			expect(store.error).toBe('offline');

			newerMutation.resolve({ success: true, snapshot: snapshot(5, ['a', 'b', 'c']) });
			await newer;
			expect(store.snapshot).toEqual(snapshot(5, ['a', 'b', 'c']));
			expect(store.error).toBe('still offline');

			olderMutation.resolve({ success: true, snapshot: snapshot(4, ['a', 'b']) });
			await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(3));
			expect(store.snapshot).toEqual(snapshot(5, ['a', 'b', 'c']));
			expect(store.error).toBe('still offline');
			expect(store.hasFreshSnapshot).toBe(false);

			reconcile.resolve(snapshot(5, ['a', 'b', 'c']));
			expect(await older).toEqual(snapshot(5, ['a', 'b', 'c']));
			expect(store.error).toBeNull();
			expect(store.hasFreshSnapshot).toBe(true);
		});

		it('reconciles when a stale ignored mutation ack lands before an overlapping GET rejects', async () => {
			const delayedAck = Promise.withResolvers<{ success: true; snapshot: Snapshot }>();
			const outstanding = Promise.withResolvers<Snapshot>();
			const afterStaleAck = Promise.withResolvers<Snapshot>();
			const get = vi
				.fn<() => Promise<Snapshot>>()
				.mockReturnValueOnce(Promise.resolve(snapshot(5, ['a', 'b', 'c'])))
				.mockReturnValueOnce(outstanding.promise)
				.mockReturnValueOnce(afterStaleAck.promise);
			const create = vi.fn(() => delayedAck.promise);
			const store = createStore({ get, create });
			store.applySnapshot(snapshot(3, ['a']));

			const delayedCreate = createItem(store, 'b');
			await store.refreshIfLoaded();
			expect(store.snapshot).toEqual(snapshot(5, ['a', 'b', 'c']));

			const outstandingRead = store.refresh().catch((error) => error);
			delayedAck.resolve({ success: true, snapshot: snapshot(4, ['a', 'b']) });
			expect(await delayedCreate).toEqual(snapshot(5, ['a', 'b', 'c']));

			const failure = new Error('transient');
			outstanding.reject(failure);
			expect(await outstandingRead).toBe(failure);
			await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(3));
			expect(store.snapshot).toEqual(snapshot(5, ['a', 'b', 'c']));
			expect(store.error).toBe('transient');
			expect(store.hasFreshSnapshot).toBe(false);

			afterStaleAck.resolve(snapshot(5, ['a', 'b', 'c']));
			await vi.waitFor(() => expect(store.hasFreshSnapshot).toBe(true));
			expect(store.error).toBeNull();
		});
	});
}
