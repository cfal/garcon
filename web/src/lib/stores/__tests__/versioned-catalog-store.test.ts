import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '$lib/api/client.js';
import { VersionedCatalogStore } from '../versioned-catalog-store.svelte.js';

interface TestSnapshot {
	readonly revision: number;
	readonly ids: readonly string[];
}

function snapshot(revision: number, ids: string[]): TestSnapshot {
	return { revision, ids };
}

function createStore(
	load: () => Promise<TestSnapshot> = () => Promise.resolve(snapshot(0, [])),
): VersionedCatalogStore<TestSnapshot> {
	return new VersionedCatalogStore<TestSnapshot>({
		load,
		loadErrorMessage: 'Failed to load test catalog',
		revisionConflictCode: 'TEST_REVISION_CONFLICT',
	});
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

describe('VersionedCatalogStore', () => {
	it('marks a loaded store refreshing, clears prior error on retry, and settles freshness', async () => {
		const retryRead = Promise.withResolvers<TestSnapshot>();
		const get = vi
			.fn<() => Promise<TestSnapshot>>()
			.mockRejectedValueOnce(new Error('offline'))
			.mockReturnValueOnce(retryRead.promise);
		const store = createStore(get);
		store.applySnapshot(snapshot(1, ['a']));
		expect(store.hasFreshSnapshot).toBe(true);

		await expect(store.refresh()).rejects.toThrow('offline');
		expect(store.error).toBe('offline');
		expect(store.hasFreshSnapshot).toBe(false);

		const retrying = store.refresh();
		expect(store.status).toBe('ready');
		expect(store.isRefreshing).toBe(true);
		expect(store.error).toBeNull();
		expect(store.hasFreshSnapshot).toBe(false);

		retryRead.resolve(snapshot(2, ['a', 'b']));
		await retrying;
		expect(store.isRefreshing).toBe(false);
		expect(store.hasFreshSnapshot).toBe(true);
		expect(store.snapshot).toEqual(snapshot(2, ['a', 'b']));
	});

	it('replaces the catalog immediately when an authoritative refresh returns a restored lower revision', async () => {
		const get = vi
			.fn<() => Promise<TestSnapshot>>()
			.mockReturnValueOnce(Promise.resolve(snapshot(1, ['restored'])))
			.mockReturnValueOnce(Promise.resolve(snapshot(2, ['updated'])));
		const store = createStore(get);
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
		const staleRead = Promise.withResolvers<TestSnapshot>();
		const newerRead = Promise.withResolvers<TestSnapshot>();
		const get = vi
			.fn<() => Promise<TestSnapshot>>()
			.mockReturnValueOnce(staleRead.promise)
			.mockReturnValueOnce(newerRead.promise);
		const store = createStore(get);
		store.applySnapshot(snapshot(1, ['a']));

		const staleReading = store.refresh();
		expect(store.hasFreshSnapshot).toBe(false);
		await store.mutate(() => Promise.resolve({ snapshot: snapshot(2, ['a', 'b']) }));
		expect(store.snapshot).toEqual(snapshot(2, ['a', 'b']));

		staleRead.resolve(snapshot(1, ['a']));
		await staleReading;
		expect(store.snapshot).toEqual(snapshot(2, ['a', 'b']));
		expect(store.hasFreshSnapshot).toBe(true);

		const newerReading = store.refresh();
		await store.mutate(() => Promise.resolve({ snapshot: snapshot(3, ['a', 'b', 'c']) }));
		expect(store.snapshot).toEqual(snapshot(3, ['a', 'b', 'c']));
		newerRead.resolve(snapshot(4, ['a', 'b', 'c', 'd']));
		await newerReading;
		expect(store.snapshot).toEqual(snapshot(4, ['a', 'b', 'c', 'd']));
		expect(store.hasFreshSnapshot).toBe(true);
	});

	it('keeps local lookup ineligible across every microtask of a queued invalidation loop', async () => {
		const reads = deferredQueue<TestSnapshot>();
		const store = createStore(reads.fn);
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
		expect(store.snapshot).toEqual(snapshot(3, ['a', 'b']));
		expect(store.hasFreshSnapshot).toBe(true);
	});

	it.each([0, 1, 2])(
		'does not lose an invalidation queued %i microtask(s) after a joined GET settles',
		async (delayTicks) => {
			const reads = deferredQueue<TestSnapshot>();
			const store = createStore(reads.fn);
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

	it('ignores stale applySnapshot revisions and rolls back previews on superseded mutation acknowledgements', async () => {
		const store = createStore();
		store.applySnapshot(snapshot(4, ['a', 'b']));
		store.applySnapshot(snapshot(3, ['a']));
		expect(store.snapshot).toEqual(snapshot(4, ['a', 'b']));

		const pending = Promise.withResolvers<{ snapshot: TestSnapshot }>();
		const mutating = store.mutate(() => pending.promise, {
			preview: snapshot(4, ['b', 'a']),
		});
		expect(store.snapshot).toEqual(snapshot(4, ['b', 'a']));

		store.applySnapshot(snapshot(5, ['a', 'b', 'c']));
		pending.resolve({ snapshot: snapshot(4, ['b', 'a']) });
		expect(await mutating).toEqual(snapshot(5, ['a', 'b', 'c']));
		expect(store.snapshot).toEqual(snapshot(5, ['a', 'b', 'c']));
	});

	it('does not let a stale pre-mutation GET error overwrite a fresh post-mutation snapshot', async () => {
		const deferredRead = Promise.withResolvers<TestSnapshot>();
		const store = createStore(vi.fn<() => Promise<TestSnapshot>>().mockReturnValueOnce(deferredRead.promise));
		store.applySnapshot(snapshot(1, ['a']));

		const staleReading = store.refresh();
		await store.mutate(() => Promise.resolve({ snapshot: snapshot(2, ['a', 'b']) }));
		expect(store.snapshot).toEqual(snapshot(2, ['a', 'b']));

		const failure = new Error('stale network failure');
		deferredRead.reject(failure);
		await expect(staleReading).rejects.toBe(failure);
		expect(store.snapshot).toEqual(snapshot(2, ['a', 'b']));
		expect(store.error).toBeNull();
		expect(store.hasFreshSnapshot).toBe(true);
	});

	it('refreshes on matching revision conflicts and rethrows without refreshing for other errors', async () => {
		const get = vi.fn().mockResolvedValue(snapshot(3, ['a', 'b']));
		const store = createStore(get);
		store.applySnapshot(snapshot(2, ['a']));

		const revisionConflict = new ApiError(409, 'revision conflict', 'TEST_REVISION_CONFLICT');
		await expect(store.mutate(() => Promise.reject(revisionConflict))).rejects.toBe(revisionConflict);
		expect(get).toHaveBeenCalledTimes(1);
		expect(store.snapshot).toEqual(snapshot(3, ['a', 'b']));

		const otherConflict = new ApiError(409, 'name conflict', 'TEST_OTHER_CONFLICT');
		await expect(store.mutate(() => Promise.reject(otherConflict))).rejects.toBe(otherConflict);
		expect(get).toHaveBeenCalledTimes(1);
	});

	it('rolls back overlapping optimistic previews in LIFO order regardless of rejection order', async () => {
		const store = createStore();
		store.applySnapshot(snapshot(1, ['a', 'b', 'c']));

		const first = Promise.withResolvers<{ snapshot: TestSnapshot }>();
		const second = Promise.withResolvers<{ snapshot: TestSnapshot }>();
		const m1 = store.mutate(() => first.promise, { preview: snapshot(1, ['a', 'c', 'b']) });
		const m2 = store.mutate(() => second.promise, { preview: snapshot(1, ['c', 'a', 'b']) });
		expect(store.snapshot?.ids).toEqual(['c', 'a', 'b']);

		first.reject(new Error('first failed'));
		await expect(m1).rejects.toThrow('first failed');
		expect(store.snapshot?.ids).toEqual(['c', 'a', 'b']);

		second.reject(new Error('second failed'));
		await expect(m2).rejects.toThrow('second failed');
		expect(store.snapshot).toEqual(snapshot(1, ['a', 'b', 'c']));
	});
});
