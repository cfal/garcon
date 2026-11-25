import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '$lib/api/client';
import { describeVersionedCatalogConcurrencyContract } from '$lib/stores/__tests__/versioned-catalog-contract.js';
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

describeVersionedCatalogConcurrencyContract('PreamblesStore', {
	snapshot,
	createStore: (deps) => new PreamblesStore(deps),
	createItem: (store, id) =>
		store.create({
			enabled: true,
			title: `Preamble ${id}`,
			content: `Content ${id}`,
			scope: { type: 'global' },
		}),
	removeItem: (store, id) => store.remove(id),
});

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
		const mutation = Promise.withResolvers<{ success: true; snapshot: PreamblesSnapshot }>();
		const reorder = vi.fn(() => mutation.promise);
		const store = new PreamblesStore({ reorder });
		store.applySnapshot(snapshot(2, ['a', 'b']));

		const moving = store.move('b', 'up');
		await vi.waitFor(() => expect(reorder).toHaveBeenCalledOnce());
		expect(store.preambles.map((entry) => entry.id)).toEqual(['b', 'a']);
		mutation.resolve({ success: true, snapshot: snapshot(3, ['b', 'a']) });
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

	it('rolls back an overlapping second move to the first move displayed order', async () => {
		const firstMove = Promise.withResolvers<{ success: true; snapshot: PreamblesSnapshot }>();
		const secondMove = Promise.withResolvers<{ success: true; snapshot: PreamblesSnapshot }>();
		const reorder = vi
			.fn()
			.mockReturnValueOnce(firstMove.promise)
			.mockReturnValueOnce(secondMove.promise);
		const store = new PreamblesStore({ reorder });
		store.applySnapshot(snapshot(2, ['a', 'b', 'c']));

		const movingFirst = store.move('c', 'up');
		expect(store.preambles.map((entry) => entry.id)).toEqual(['a', 'c', 'b']);

		const movingSecond = store.move('c', 'up');
		expect(store.preambles.map((entry) => entry.id)).toEqual(['c', 'a', 'b']);

		const failure = new Error('second move failed');
		secondMove.reject(failure);
		await expect(movingSecond).rejects.toBe(failure);
		expect(store.preambles.map((entry) => entry.id)).toEqual(['a', 'c', 'b']);

		firstMove.resolve({ success: true, snapshot: snapshot(3, ['a', 'c', 'b']) });
		await movingFirst;
		expect(store.snapshot).toEqual(snapshot(3, ['a', 'c', 'b']));
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
		const first = Promise.withResolvers<PreamblesSnapshot>();
		const second = Promise.withResolvers<PreamblesSnapshot>();
		const get = vi
			.fn<() => Promise<PreamblesSnapshot>>()
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise);
		const conflict = new ApiError(409, 'revision conflict', 'PREAMBLE_REVISION_CONFLICT');
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
		first.resolve(snapshot(3, ['a']));
		await refreshing;
		await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(2));
		second.resolve(snapshot(4, ['a', 'b']));

		await expect(updating).rejects.toBe(conflict);
		expect(store.snapshot).toEqual(snapshot(4, ['a', 'b']));
	});

	it('performs a post-conflict read after a joined refresh fails', async () => {
		const conflict = new ApiError(409, 'revision conflict', 'PREAMBLE_REVISION_CONFLICT');
		const read = Promise.withResolvers<PreamblesSnapshot>();
		const refreshFailure = new Error('refresh unavailable');
		const get = vi
			.fn<() => Promise<PreamblesSnapshot>>()
			.mockReturnValueOnce(read.promise)
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
		read.reject(refreshFailure);

		expect(await refreshing).toBe(refreshFailure);
		await expect(updating).rejects.toBe(conflict);
		expect(get).toHaveBeenCalledTimes(2);
		expect(store.snapshot).toEqual(snapshot(4, ['a', 'b']));
	});

	it('retries when a conflict joins a failing refresh-loop load', async () => {
		const conflict = new ApiError(409, 'revision conflict', 'PREAMBLE_REVISION_CONFLICT');
		const read = Promise.withResolvers<PreamblesSnapshot>();
		const get = vi
			.fn<() => Promise<PreamblesSnapshot>>()
			.mockReturnValueOnce(read.promise)
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
		read.reject(new Error('refresh unavailable'));

		await refreshing;
		await expect(updating).rejects.toBe(conflict);
		expect(get).toHaveBeenCalledTimes(2);
		expect(store.snapshot).toEqual(snapshot(4, ['a', 'b']));
	});

	it('refreshes again when invalidated during an in-flight load', async () => {
		const firstRead = Promise.withResolvers<PreamblesSnapshot>();
		const secondRead = Promise.withResolvers<PreamblesSnapshot>();
		const get = vi
			.fn<() => Promise<PreamblesSnapshot>>()
			.mockReturnValueOnce(firstRead.promise)
			.mockReturnValueOnce(secondRead.promise);
		const store = new PreamblesStore({ get });
		store.applySnapshot(snapshot(1, ['a']));

		const first = store.refreshIfLoaded();
		const second = store.refreshIfLoaded();
		firstRead.resolve(snapshot(2, ['a']));
		await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(2));
		secondRead.resolve(snapshot(3, ['a', 'b']));
		await Promise.all([first, second]);

		expect(store.snapshot).toEqual(snapshot(3, ['a', 'b']));
	});

	it('does not replace a newer mutation snapshot with a stale read', () => {
		const store = new PreamblesStore();
		store.applySnapshot(snapshot(4, ['a', 'b']));
		store.applySnapshot(snapshot(3, ['a']));
		expect(store.snapshot).toEqual(snapshot(4, ['a', 'b']));
	});

	it('withholds delayed reorder results across a lower-revision restore boundary', async () => {
		const mutation = Promise.withResolvers<{ success: true; snapshot: PreamblesSnapshot }>();
		const reorder = vi.fn(() => mutation.promise);
		const get = vi
			.fn<() => Promise<PreamblesSnapshot>>()
			.mockResolvedValueOnce(snapshot(0, []))
			.mockResolvedValueOnce(snapshot(0, []));
		const store = new PreamblesStore({ get, reorder });
		store.applySnapshot(snapshot(3, ['a', 'b']));

		const moving = store.move('b', 'up');
		expect(reorder).toHaveBeenCalledOnce();
		await store.refreshIfLoaded();
		expect(store.snapshot).toEqual(snapshot(0, []));
		expect(store.hasFreshSnapshot).toBe(true);

		mutation.resolve({ success: true, snapshot: snapshot(4, ['b', 'a']) });
		await moving;
		expect(get).toHaveBeenCalledTimes(2);
		expect(store.snapshot).toEqual(snapshot(0, []));
		expect(store.hasFreshSnapshot).toBe(true);
	});

	it('rolls back an optimistic move and queues a post-ack GET when ack lands during an in-flight reconnect GET', async () => {
		const firstRead = Promise.withResolvers<PreamblesSnapshot>();
		const secondRead = Promise.withResolvers<PreamblesSnapshot>();
		const get = vi
			.fn<() => Promise<PreamblesSnapshot>>()
			.mockReturnValueOnce(firstRead.promise)
			.mockReturnValueOnce(secondRead.promise);
		const mutation = Promise.withResolvers<{ success: true; snapshot: PreamblesSnapshot }>();
		const reorder = vi.fn(() => mutation.promise);
		const store = new PreamblesStore({ get, reorder });
		store.applySnapshot(snapshot(3, ['a', 'b']));

		const moving = store.move('b', 'up');
		expect(reorder).toHaveBeenCalledOnce();
		expect(store.preambles.map((entry) => entry.id)).toEqual(['b', 'a']);

		const reconnecting = store.reconcileAfterReconnect();
		await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1));

		mutation.resolve({ success: true, snapshot: snapshot(4, ['b', 'a']) });
		await vi.waitFor(() =>
			expect(store.preambles.map((entry) => entry.id)).toEqual(['a', 'b']),
		);

		firstRead.resolve(snapshot(3, ['a', 'b']));
		await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(2));
		secondRead.resolve(snapshot(4, ['a', 'b']));
		await Promise.all([moving, reconnecting]);
		expect(store.preambles.map((entry) => entry.id)).toEqual(['a', 'b']);
		expect(store.hasFreshSnapshot).toBe(true);
	});

	it('does not misclassify an optimistic move as a reset when a pre-move same-revision GET returns confirmed order', async () => {
		const mutation = Promise.withResolvers<{ success: true; snapshot: PreamblesSnapshot }>();
		const reorder = vi.fn(() => mutation.promise);
		const get = vi.fn<() => Promise<PreamblesSnapshot>>().mockResolvedValueOnce(snapshot(3, ['a', 'b']));
		const store = new PreamblesStore({ get, reorder });
		store.applySnapshot(snapshot(3, ['a', 'b']));

		const moving = store.move('b', 'up');
		await store.refreshIfLoaded();
		mutation.resolve({ success: true, snapshot: snapshot(4, ['b', 'a']) });
		await moving;
		expect(get).toHaveBeenCalledTimes(1);
		expect(store.snapshot).toEqual(snapshot(4, ['b', 'a']));
		expect(store.hasFreshSnapshot).toBe(true);
	});
});
