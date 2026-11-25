import { describe, expect, it, vi } from 'vitest';
import { SnippetsStore } from '../snippets-store.svelte';
import { ApiError } from '$lib/api/client.js';
import type { Snippet, SnippetsSnapshot } from '$shared/snippets';
import { SNIPPET_ERROR_CODES } from '$shared/snippets';

function snippet(id: string): Snippet {
	return {
		id,
		shortName: `snippet-${id}`,
		template: `Template ${id}`,
		defaultArguments: '',
		createdAt: '2029-01-01T00:00:00.000Z',
		updatedAt: '2029-01-01T00:00:00.000Z',
	};
}

function snapshot(revision: number, ids: string[]): SnippetsSnapshot {
	return { revision, snippets: ids.map(snippet) };
}

describe('SnippetsStore', () => {
	it('honors queued invalidation after a failed refresh', async () => {
		let rejectRead!: (error: Error) => void;
		const get = vi.fn()
			.mockImplementationOnce(() => new Promise<SnippetsSnapshot>((_, reject) => { rejectRead = reject; }))
			.mockResolvedValueOnce(snapshot(2, ['a', 'b']));
		const store = new SnippetsStore({ get });
		store.applySnapshot(snapshot(1, ['a']));

		const first = store.refreshIfLoaded();
		const second = store.refreshIfLoaded();
		rejectRead(new Error('disconnected'));
		await Promise.all([first, second]);

		expect(get).toHaveBeenCalledTimes(2);
		expect(store.snapshot).toEqual(snapshot(2, ['a', 'b']));
		expect(store.error).toBeNull();
	});

	it('honors invalidation after a failed initial load', async () => {
		let rejectRead!: (error: Error) => void;
		const get = vi.fn()
			.mockImplementationOnce(() => new Promise<SnippetsSnapshot>((_, reject) => { rejectRead = reject; }))
			.mockResolvedValueOnce(snapshot(2, ['a']));
		const store = new SnippetsStore({ get });
		const failure = new Error('disconnected');
		const initial = expect(store.ensureLoaded()).rejects.toBe(failure);
		const invalidated = store.refreshIfLoaded();
		rejectRead(failure);
		await initial;
		await invalidated;

		expect(get).toHaveBeenCalledTimes(2);
		expect(store.snapshot).toEqual(snapshot(2, ['a']));
	});

	it('does not retry failed reads without another invalidation', async () => {
		const get = vi.fn().mockRejectedValue(new Error('disconnected'));
		const store = new SnippetsStore({ get });
		store.applySnapshot(snapshot(1, ['a']));
		await store.refreshIfLoaded();
		expect(get).toHaveBeenCalledTimes(1);
		expect(store.snapshot).toEqual(snapshot(1, ['a']));
		expect(store.error).toBe('disconnected');
	});

	it('loads lazily and applies canonical mutation snapshots', async () => {
		const get = vi.fn().mockResolvedValue(snapshot(0, []));
		const create = vi.fn().mockResolvedValue({ success: true, snapshot: snapshot(1, ['a']) });
		const store = new SnippetsStore({ get, create });
		expect(get).not.toHaveBeenCalled();

		await store.ensureLoaded();
		await store.create({ shortName: 'a', template: 'Template a', defaultArguments: '' });

		expect(create).toHaveBeenCalledWith({
			expectedRevision: 0,
			snippet: { shortName: 'a', template: 'Template a', defaultArguments: '' },
		});
		expect(store.snapshot).toEqual(snapshot(1, ['a']));
	});

	it('refreshes after a revision conflict and preserves the original rejection', async () => {
		const conflict = new ApiError(409, 'revision conflict', SNIPPET_ERROR_CODES.revisionConflict);
		const get = vi.fn().mockResolvedValue(snapshot(3, ['a', 'b']));
		const create = vi.fn().mockRejectedValue(conflict);
		const store = new SnippetsStore({ get, create });
		store.applySnapshot(snapshot(2, ['a']));

		await expect(
			store.create({ shortName: 'b', template: 'Template b', defaultArguments: '' }),
		).rejects.toBe(conflict);

		expect(get).toHaveBeenCalledTimes(1);
		expect(store.snapshot).toEqual(snapshot(3, ['a', 'b']));
	});

	it('starts a fresh refresh when conflict recovery joined an older request', async () => {
		const resolvers: Array<(value: SnippetsSnapshot) => void> = [];
		const get = vi.fn(() => new Promise<SnippetsSnapshot>((resolve) => resolvers.push(resolve)));
		const conflict = new ApiError(409, 'revision conflict', SNIPPET_ERROR_CODES.revisionConflict);
		const store = new SnippetsStore({ get, create: vi.fn().mockRejectedValue(conflict) });
		store.applySnapshot(snapshot(1, ['a']));
		const olderRefresh = store.refresh();
		const creating = store.create({
			shortName: 'b',
			template: 'Template b',
			defaultArguments: '',
		});

		await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1));
		resolvers[0](snapshot(1, ['a']));
		await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(2));
		resolvers[1](snapshot(2, ['a', 'b']));

		await olderRefresh;
		await expect(creating).rejects.toBe(conflict);
		expect(store.snapshot).toEqual(snapshot(2, ['a', 'b']));
	});

	it('does not refresh for non-revision conflicts', async () => {
		const get = vi.fn();
		const conflict = new ApiError(409, 'name conflict', SNIPPET_ERROR_CODES.nameConflict);
		const store = new SnippetsStore({ get, create: vi.fn().mockRejectedValue(conflict) });
		store.applySnapshot(snapshot(1, ['a']));

		await expect(
			store.create({ shortName: 'a', template: 'Other', defaultArguments: '' }),
		).rejects.toBe(conflict);

		expect(get).not.toHaveBeenCalled();
	});

	it('refreshes again when invalidated during an in-flight refresh', async () => {
		const resolvers: Array<(value: SnippetsSnapshot) => void> = [];
		const get = vi.fn(() => new Promise<SnippetsSnapshot>((resolve) => resolvers.push(resolve)));
		const store = new SnippetsStore({ get });
		store.applySnapshot(snapshot(1, ['a']));

		const first = store.refreshIfLoaded();
		const second = store.refreshIfLoaded();
		resolvers[0](snapshot(2, ['a']));
		await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(2));
		resolvers[1](snapshot(3, ['a', 'b']));
		await Promise.all([first, second]);

		expect(store.snapshot).toEqual(snapshot(3, ['a', 'b']));
	});

	it('refreshes after an invalidation during the initial load', async () => {
		const resolvers: Array<(value: SnippetsSnapshot) => void> = [];
		const get = vi.fn(() => new Promise<SnippetsSnapshot>((resolve) => resolvers.push(resolve)));
		const store = new SnippetsStore({ get });

		const initial = store.ensureLoaded();
		const invalidated = store.refreshIfLoaded();
		resolvers[0](snapshot(1, ['a']));
		await initial;
		await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(2));
		resolvers[1](snapshot(2, ['a', 'b']));
		await invalidated;

		expect(store.snapshot).toEqual(snapshot(2, ['a', 'b']));
	});

	it('does not replace a newer snapshot with a stale response', () => {
		const store = new SnippetsStore();
		store.applySnapshot(snapshot(4, ['a', 'b']));

		store.applySnapshot(snapshot(3, ['a']));

		expect(store.snapshot).toEqual(snapshot(4, ['a', 'b']));
	});

	it('marks an already-loaded store refreshing and ineligible for local lookup while a retry GET is in flight', async () => {
		let resolveRead!: (value: SnippetsSnapshot) => void;
		const get = vi.fn(
			() =>
				new Promise<SnippetsSnapshot>((resolve) => {
					resolveRead = resolve;
				}),
		);
		const store = new SnippetsStore({ get });
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
		expect(store.snapshot).toEqual(snapshot(2, ['a', 'b']));
	});

	it('replaces the catalog immediately when an authoritative refresh returns a restored lower revision', async () => {
		const get = vi
			.fn()
			.mockResolvedValueOnce(snapshot(1, ['restored']))
			.mockResolvedValueOnce(snapshot(2, ['updated']));
		const store = new SnippetsStore({ get });
		store.applySnapshot(snapshot(3, ['probe']));
		expect(store.hasFreshSnapshot).toBe(true);

		await store.refreshIfLoaded();
		expect(store.snapshot).toEqual(snapshot(1, ['restored']));
		expect(store.hasFreshSnapshot).toBe(true);

		await store.refreshIfLoaded();
		expect(store.snapshot).toEqual(snapshot(2, ['updated']));
		expect(store.hasFreshSnapshot).toBe(true);
	});

	it('heals to a restored lower revision after a mutation hits a 409 revision conflict', async () => {
		const conflict = new ApiError(409, 'revision conflict', SNIPPET_ERROR_CODES.revisionConflict);
		const get = vi.fn().mockResolvedValueOnce(snapshot(1, ['restored']));
		const create = vi.fn().mockRejectedValueOnce(conflict);
		const store = new SnippetsStore({ get, create });
		store.applySnapshot(snapshot(3, ['probe']));

		await expect(
			store.create({ shortName: 'snippet-b', template: 'Template b', defaultArguments: '' }),
		).rejects.toBe(conflict);

		expect(store.snapshot).toEqual(snapshot(1, ['restored']));
		expect(store.hasFreshSnapshot).toBe(true);
	});

	it('ignores a stale GET overtaken by a mutation while applying a concurrent GET that saw a newer revision', async () => {
		let resolveStaleRead!: (value: SnippetsSnapshot) => void;
		let resolveNewerRead!: (value: SnippetsSnapshot) => void;
		const get = vi
			.fn()
			.mockImplementationOnce(
				() =>
					new Promise<SnippetsSnapshot>((resolve) => {
						resolveStaleRead = resolve;
					}),
			)
			.mockImplementationOnce(
				() =>
					new Promise<SnippetsSnapshot>((resolve) => {
						resolveNewerRead = resolve;
					}),
			);
		const create = vi
			.fn()
			.mockResolvedValueOnce({ success: true, snapshot: snapshot(2, ['a', 'b']) })
			.mockResolvedValueOnce({ success: true, snapshot: snapshot(3, ['a', 'b', 'c']) });
		const store = new SnippetsStore({ get, create });
		store.applySnapshot(snapshot(1, ['a']));

		const staleReading = store.refresh();
		expect(store.hasFreshSnapshot).toBe(false);

		await store.create({ shortName: 'snippet-b', template: 'Template b', defaultArguments: '' });
		expect(store.snapshot).toEqual(snapshot(2, ['a', 'b']));

		resolveStaleRead(snapshot(1, ['a']));
		await staleReading;
		expect(store.snapshot).toEqual(snapshot(2, ['a', 'b']));
		expect(store.hasFreshSnapshot).toBe(true);

		// A concurrent GET that actually observed revision 4 after mutation revision 3 is still applied.
		const newerReading = store.refresh();
		await store.create({ shortName: 'snippet-c', template: 'Template c', defaultArguments: '' });
		expect(store.snapshot).toEqual(snapshot(3, ['a', 'b', 'c']));
		resolveNewerRead(snapshot(4, ['a', 'b', 'c', 'd']));
		await newerReading;
		expect(store.snapshot).toEqual(snapshot(4, ['a', 'b', 'c', 'd']));
		expect(store.hasFreshSnapshot).toBe(true);
	});

	it('keeps local lookup ineligible across every microtask of a queued invalidation loop', async () => {
		const resolvers: Array<(value: SnippetsSnapshot) => void> = [];
		const get = vi.fn(() => new Promise<SnippetsSnapshot>((resolve) => resolvers.push(resolve)));
		const store = new SnippetsStore({ get });
		store.applySnapshot(snapshot(1, ['a']));

		const first = store.refreshIfLoaded();
		const second = store.refreshIfLoaded();
		expect(store.hasFreshSnapshot).toBe(false);

		const samples: boolean[] = [];
		resolvers[0](snapshot(2, ['a']));
		for (let step = 0; step < 32 && get.mock.calls.length < 2; step += 1) {
			samples.push(store.hasFreshSnapshot);
			await Promise.resolve();
		}
		expect(get).toHaveBeenCalledTimes(2);
		expect(samples.length).toBeGreaterThan(1);
		expect(samples).not.toContain(true);

		resolvers[1](snapshot(3, ['a', 'b']));
		await Promise.all([first, second]);
		expect(store.hasFreshSnapshot).toBe(true);
	});

	it.each([0, 1, 2])(
		'does not lose an invalidation queued %i microtask(s) after a joined GET settles',
		async (delayTicks) => {
			const resolvers: Array<(value: SnippetsSnapshot) => void> = [];
			const get = vi.fn(() => new Promise<SnippetsSnapshot>((resolve) => resolvers.push(resolve)));
			const store = new SnippetsStore({ get });
			store.applySnapshot(snapshot(1, ['a']));

			const first = store.refreshIfLoaded();
			let joined: Promise<unknown> = store.refresh();
			for (let tick = 0; tick < delayTicks; tick += 1) {
				joined = joined.then(() => undefined);
			}
			const second = joined.then(() => store.refreshIfLoaded());
			resolvers[0](snapshot(2, ['a']));
			await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(2));
			expect(store.hasFreshSnapshot).toBe(false);

			resolvers[1](snapshot(3, ['a', 'b']));
			await Promise.all([first, second]);
			expect(store.snapshot).toEqual(snapshot(3, ['a', 'b']));
			expect(store.hasFreshSnapshot).toBe(true);
		},
	);

	it('withholds delayed mutation results across reconnect and revision regression boundaries', async () => {
		let resolveRegressed!: (value: { success: true; snapshot: SnippetsSnapshot }) => void;
		const createRegressed = vi.fn(
			() =>
				new Promise<{ success: true; snapshot: SnippetsSnapshot }>((resolve) => {
					resolveRegressed = resolve;
				}),
		);
		const regressedGet = vi
			.fn()
			.mockResolvedValueOnce(snapshot(0, []))
			.mockResolvedValueOnce(snapshot(0, []));
		const regressedStore = new SnippetsStore({ get: regressedGet, create: createRegressed });
		regressedStore.applySnapshot(snapshot(3, ['probe']));

		const creating = regressedStore.create({
			shortName: 'snippet-b',
			template: 'Template b',
			defaultArguments: '',
		});
		expect(createRegressed).toHaveBeenCalledOnce();
		await regressedStore.refreshIfLoaded();
		expect(regressedStore.snapshot).toEqual(snapshot(0, []));
		expect(regressedStore.hasFreshSnapshot).toBe(true);

		resolveRegressed({ success: true, snapshot: snapshot(4, ['probe', 'b']) });
		expect(await creating).toEqual(snapshot(0, []));
		expect(regressedGet).toHaveBeenCalledTimes(2);
		expect(regressedStore.snapshot).toEqual(snapshot(0, []));
		expect(regressedStore.hasFreshSnapshot).toBe(true);

		// Same-revision reconnect restore (revision 3 -> restored revision 3) must also withhold delayed rev 4.
		let resolveSameRev!: (value: { success: true; snapshot: SnippetsSnapshot }) => void;
		const createSameRev = vi.fn(
			() =>
				new Promise<{ success: true; snapshot: SnippetsSnapshot }>((resolve) => {
					resolveSameRev = resolve;
				}),
		);
		const restoredGet = vi
			.fn()
			.mockResolvedValueOnce(snapshot(3, ['restored']))
			.mockResolvedValueOnce(snapshot(3, ['restored']));
		const reconnectStore = new SnippetsStore({ get: restoredGet, create: createSameRev });
		reconnectStore.applySnapshot(snapshot(3, ['original']));

		const creatingAcrossReconnect = reconnectStore.create({
			shortName: 'snippet-stale',
			template: 'Stale',
			defaultArguments: '',
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
		let resolveRemove!: (value: { success: true; snapshot: SnippetsSnapshot }) => void;
		const remove = vi.fn(
			() =>
				new Promise<{ success: true; snapshot: SnippetsSnapshot }>((resolve) => {
					resolveRemove = resolve;
				}),
		);
		let rejectRetry!: (error: Error) => void;
		const failingGet = vi
			.fn<() => Promise<SnippetsSnapshot>>()
			.mockRejectedValueOnce(new Error('offline'))
			.mockImplementationOnce(
				() =>
					new Promise<SnippetsSnapshot>((_resolve, reject) => {
						rejectRetry = reject;
					}),
			);
		const store = new SnippetsStore({ get: failingGet, remove });
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
		const resolvers: Array<(value: SnippetsSnapshot) => void> = [];
		const get = vi.fn(() => new Promise<SnippetsSnapshot>((resolve) => resolvers.push(resolve)));
		const store = new SnippetsStore({ get });
		store.applySnapshot(snapshot(3, ['original']));

		const preReconnectRead = store.refresh();
		const reconnecting = store.reconcileAfterReconnect();
		resolvers[0](snapshot(4, ['stale-old-authority']));
		await preReconnectRead;

		await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(2));
		expect(store.snapshot).toEqual(snapshot(3, ['original']));
		expect(store.hasFreshSnapshot).toBe(false);

		resolvers[1](snapshot(3, ['restored']));
		await reconnecting;
		expect(store.snapshot).toEqual(snapshot(3, ['restored']));
		expect(store.hasFreshSnapshot).toBe(true);
	});

	it('ignores a pre-reconnect initial GET without a retained snapshot until reconnect GET finishes', async () => {
		const resolvers: Array<(value: SnippetsSnapshot) => void> = [];
		const get = vi.fn(() => new Promise<SnippetsSnapshot>((resolve) => resolvers.push(resolve)));
		const store = new SnippetsStore({ get });

		const initialLoad = store.ensureLoaded();
		const reconnecting = store.reconcileAfterReconnect();
		resolvers[0](snapshot(4, ['stale-old-authority']));

		await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(2));
		expect(store.snapshot).toBeNull();
		expect(store.status).toBe('loading');
		expect(store.hasFreshSnapshot).toBe(false);

		resolvers[1](snapshot(3, ['restored']));
		expect(await initialLoad).toEqual(snapshot(3, ['restored']));
		await reconnecting;
		expect(store.snapshot).toEqual(snapshot(3, ['restored']));
		expect(store.status).toBe('ready');
		expect(store.hasFreshSnapshot).toBe(true);
	});

	it('delivers the post-reconnect GET outcome to all concurrent initial ensureLoaded callers when the pre-reconnect GET rejects', async () => {
		const deferreds: Array<{
			resolve: (value: SnippetsSnapshot) => void;
			reject: (error: Error) => void;
		}> = [];
		const get = vi.fn(
			() =>
				new Promise<SnippetsSnapshot>((resolve, reject) => {
					deferreds.push({ resolve, reject });
				}),
		);
		const store = new SnippetsStore({ get });

		const first = store.ensureLoaded();
		const second = store.ensureLoaded();
		const reconnecting = store.reconcileAfterReconnect();
		const third = store.ensureLoaded();

		deferreds[0].reject(new Error('stale socket reset'));
		await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(2));
		expect(store.snapshot).toBeNull();
		expect(store.status).toBe('loading');

		deferreds[1].resolve(snapshot(3, ['restored']));
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
			resolve: (value: SnippetsSnapshot) => void;
			reject: (error: Error) => void;
		}> = [];
		const failingGet = vi.fn(
			() =>
				new Promise<SnippetsSnapshot>((resolve, reject) => {
					failureDeferreds.push({ resolve, reject });
				}),
		);
		const failingStore = new SnippetsStore({ get: failingGet });
		const f1 = failingStore.ensureLoaded();
		const f2 = failingStore.ensureLoaded();
		const fReconnect = failingStore.reconcileAfterReconnect();
		const f3 = failingStore.ensureLoaded();

		const newFailure = new Error('post-reconnect failure');
		const outcomes = Promise.allSettled([f1, f2, f3]);
		failureDeferreds[0].reject(new Error('stale socket reset'));
		await vi.waitFor(() => expect(failingGet).toHaveBeenCalledTimes(2));
		failureDeferreds[1].reject(newFailure);
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

	it('queues a post-ack reconcile GET when a withheld mutation resolves while reconnect GET is in flight', async () => {
		const getResolvers: Array<(value: SnippetsSnapshot) => void> = [];
		const get = vi.fn(
			() => new Promise<SnippetsSnapshot>((resolve) => getResolvers.push(resolve)),
		);
		let resolveCreate!: (value: { success: true; snapshot: SnippetsSnapshot }) => void;
		const create = vi.fn(
			() =>
				new Promise<{ success: true; snapshot: SnippetsSnapshot }>((resolve) => {
					resolveCreate = resolve;
				}),
		);
		const store = new SnippetsStore({ get, create });
		store.applySnapshot(snapshot(3, ['a']));

		const creating = store.create({ shortName: 'snippet-b', template: 'Template b', defaultArguments: '' });
		expect(create).toHaveBeenCalledOnce();
		const reconnecting = store.reconcileAfterReconnect();
		await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1));

		resolveCreate({ success: true, snapshot: snapshot(4, ['a', 'b']) });
		await Promise.resolve();
		expect(store.snapshot).toEqual(snapshot(3, ['a']));

		getResolvers[0](snapshot(3, ['restored']));
		await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(2));
		getResolvers[1](snapshot(4, ['restored', 'post-ack']));
		expect(await creating).toEqual(snapshot(4, ['restored', 'post-ack']));
		await reconnecting;
		expect(store.snapshot).toEqual(snapshot(4, ['restored', 'post-ack']));
		expect(store.hasFreshSnapshot).toBe(true);
	});

	it('withholds a delayed mutation when an ordinary GET returns a different same-revision catalog', async () => {
		let resolveRemove!: (value: { success: true; snapshot: SnippetsSnapshot }) => void;
		const remove = vi.fn(
			() =>
				new Promise<{ success: true; snapshot: SnippetsSnapshot }>((resolve) => {
					resolveRemove = resolve;
				}),
		);
		const get = vi
			.fn<() => Promise<SnippetsSnapshot>>()
			.mockResolvedValueOnce(snapshot(3, ['c']))
			.mockResolvedValueOnce(snapshot(3, ['c']));
		const store = new SnippetsStore({ get, remove });
		store.applySnapshot(snapshot(3, ['a', 'b']));

		const removing = store.remove('b');
		expect(remove).toHaveBeenCalledOnce();
		await store.refreshIfLoaded();
		expect(store.snapshot).toEqual(snapshot(3, ['c']));

		resolveRemove({ success: true, snapshot: snapshot(4, ['a']) });
		expect(await removing).toEqual(snapshot(3, ['c']));
		expect(get).toHaveBeenCalledTimes(2);
		expect(store.snapshot).toEqual(snapshot(3, ['c']));
		expect(store.hasFreshSnapshot).toBe(true);
	});

	it('reconciles overlapping read failures and mutations regardless of completion order or stale ack revision', async () => {
		// Case 1: mutation ack lands first, then the overlapping GET rejects.
		let rejectFirstRead!: (error: Error) => void;
		let resolveFollowUp!: (value: SnippetsSnapshot) => void;
		const get = vi
			.fn<() => Promise<SnippetsSnapshot>>()
			.mockImplementationOnce(
				() =>
					new Promise<SnippetsSnapshot>((_resolve, reject) => {
						rejectFirstRead = reject;
					}),
			)
			.mockImplementationOnce(
				() =>
					new Promise<SnippetsSnapshot>((resolve) => {
						resolveFollowUp = resolve;
					}),
			);
		const create = vi.fn().mockResolvedValueOnce({ success: true, snapshot: snapshot(4, ['a', 'b']) });
		const store = new SnippetsStore({ get, create });
		store.applySnapshot(snapshot(3, ['a']));

		const reading = store.refresh().catch((error) => error);
		await store.create({ shortName: 'snippet-b', template: 'Template b', defaultArguments: '' });
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
		let resolveOlderMutation!: (value: { success: true; snapshot: SnippetsSnapshot }) => void;
		let resolveNewerMutation!: (value: { success: true; snapshot: SnippetsSnapshot }) => void;
		let resolveReconcile!: (value: SnippetsSnapshot) => void;
		const get2 = vi
			.fn<() => Promise<SnippetsSnapshot>>()
			.mockRejectedValueOnce(new Error('offline'))
			.mockRejectedValueOnce(new Error('still offline'))
			.mockImplementationOnce(
				() =>
					new Promise<SnippetsSnapshot>((resolve) => {
						resolveReconcile = resolve;
					}),
			);
		const create2 = vi
			.fn()
			.mockImplementationOnce(
				() =>
					new Promise<{ success: true; snapshot: SnippetsSnapshot }>((resolve) => {
						resolveOlderMutation = resolve;
					}),
			)
			.mockImplementationOnce(
				() =>
					new Promise<{ success: true; snapshot: SnippetsSnapshot }>((resolve) => {
						resolveNewerMutation = resolve;
					}),
			);
		const store2 = new SnippetsStore({ get: get2, create: create2 });
		store2.applySnapshot(snapshot(3, ['a']));

		const older = store2.create({ shortName: 'snippet-b', template: 'Template b', defaultArguments: '' });
		const newer = store2.create({ shortName: 'snippet-c', template: 'Template c', defaultArguments: '' });
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
		let resolveDelayedAck!: (value: { success: true; snapshot: SnippetsSnapshot }) => void;
		let rejectOutstanding!: (error: Error) => void;
		let resolveAfterStaleAck!: (value: SnippetsSnapshot) => void;
		const get3 = vi
			.fn<() => Promise<SnippetsSnapshot>>()
			.mockResolvedValueOnce(snapshot(5, ['a', 'b', 'c']))
			.mockImplementationOnce(
				() =>
					new Promise<SnippetsSnapshot>((_resolve, reject) => {
						rejectOutstanding = reject;
					}),
			)
			.mockImplementationOnce(
				() =>
					new Promise<SnippetsSnapshot>((resolve) => {
						resolveAfterStaleAck = resolve;
					}),
			);
		const create3 = vi.fn(
			() =>
				new Promise<{ success: true; snapshot: SnippetsSnapshot }>((resolve) => {
					resolveDelayedAck = resolve;
				}),
		);
		const store3 = new SnippetsStore({ get: get3, create: create3 });
		store3.applySnapshot(snapshot(3, ['a']));

		const delayedCreate = store3.create({
			shortName: 'snippet-b',
			template: 'Template b',
			defaultArguments: '',
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
		let resolveRemove!: (value: { success: true; snapshot: SnippetsSnapshot }) => void;
		const remove = vi.fn(
			() =>
				new Promise<{ success: true; snapshot: SnippetsSnapshot }>((resolve) => {
					resolveRemove = resolve;
				}),
		);
		const get = vi
			.fn<() => Promise<SnippetsSnapshot>>()
			.mockResolvedValueOnce(snapshot(4, ['restored']))
			.mockResolvedValueOnce(snapshot(4, ['restored']));
		const store = new SnippetsStore({ get, remove });
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
