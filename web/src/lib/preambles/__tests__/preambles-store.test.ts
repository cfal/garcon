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

	it('sends the revision of the snapshot whose order was computed during a cold-load move', async () => {
		const load = Promise.withResolvers<PreamblesSnapshot>();
		const reorder = vi.fn().mockResolvedValue({ success: true, snapshot: snapshot(2, ['b', 'a', 'c']) });
		const store = new PreamblesStore({ get: vi.fn(() => load.promise), reorder });

		const loaded = store.ensureLoaded();
		const moving = store.move('b', 'up');
		load.resolve(snapshot(1, ['a', 'b', 'c']));
		await loaded;
		// Install a newer snapshot after move() awaits ensureLoaded() and before it calls reorder().
		store.applySnapshot(snapshot(2, ['c', 'a', 'b']));
		await moving;

		expect(reorder).toHaveBeenCalledWith({
			expectedRevision: 1,
			orderedPreambleIds: ['b', 'a', 'c'],
		});
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

	it('restores the confirmed order when two overlapping optimistic moves reject in reverse order', async () => {
		const firstMove = Promise.withResolvers<{ success: true; snapshot: PreamblesSnapshot }>();
		const secondMove = Promise.withResolvers<{ success: true; snapshot: PreamblesSnapshot }>();
		const reorder = vi
			.fn()
			.mockReturnValueOnce(firstMove.promise)
			.mockReturnValueOnce(secondMove.promise);
		const store = new PreamblesStore({ reorder });
		store.applySnapshot(snapshot(2, ['a', 'b', 'c']));

		const movingFirst = store.move('c', 'up');
		const movingSecond = store.move('c', 'up');
		expect(store.preambles.map((entry) => entry.id)).toEqual(['c', 'a', 'b']);

		const secondError = new Error('second move failed');
		secondMove.reject(secondError);
		await expect(movingSecond).rejects.toBe(secondError);
		expect(store.preambles.map((entry) => entry.id)).toEqual(['a', 'c', 'b']);

		const firstError = new Error('first move failed');
		firstMove.reject(firstError);
		await expect(movingFirst).rejects.toBe(firstError);
		expect(store.snapshot).toEqual(snapshot(2, ['a', 'b', 'c']));
		expect(store.hasFreshSnapshot).toBe(true);
	});

	it('skips reorder for unknown IDs or boundary moves', async () => {
		const reorder = vi.fn();
		const store = new PreamblesStore({ reorder });
		store.applySnapshot(snapshot(1, ['a', 'b']));

		await store.move('missing', 'up');
		await store.move('a', 'up');
		await store.move('b', 'down');
		expect(reorder).not.toHaveBeenCalled();
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

	it('forwards captured expectedRevision on remove and refreshes on PREAMBLE_REVISION_CONFLICT', async () => {
		const conflict = new ApiError(409, 'revision conflict', 'PREAMBLE_REVISION_CONFLICT');
		const get = vi.fn().mockResolvedValueOnce(snapshot(5, ['a']));
		const remove = vi
			.fn()
			.mockRejectedValueOnce(conflict)
			.mockResolvedValueOnce({ success: true, snapshot: snapshot(6, []) });
		const store = new PreamblesStore({ get, remove });
		store.applySnapshot(snapshot(4, ['a']));

		await expect(store.remove('a', 3)).rejects.toBe(conflict);
		expect(remove).toHaveBeenNthCalledWith(1, { expectedRevision: 3, id: 'a' });
		expect(get).toHaveBeenCalledOnce();
		expect(store.snapshot).toEqual(snapshot(5, ['a']));

		await store.remove('a', 5);
		expect(remove).toHaveBeenNthCalledWith(2, { expectedRevision: 5, id: 'a' });
		expect(store.snapshot).toEqual(snapshot(6, []));
	});

	it('completes an optimistic move when an overlapping same-revision GET returns confirmed order', async () => {
		const mutation = Promise.withResolvers<{ success: true; snapshot: PreamblesSnapshot }>();
		const reorder = vi.fn(() => mutation.promise);
		const get = vi
			.fn<() => Promise<PreamblesSnapshot>>()
			.mockResolvedValueOnce(snapshot(3, ['a', 'b']));
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
