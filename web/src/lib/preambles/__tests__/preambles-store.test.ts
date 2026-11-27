import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '$lib/api/client';
import { PreamblesStore } from '../preambles-store.svelte';
import { PREAMBLE_ERROR_CODES, type Preamble, type PreamblesSnapshot } from '$shared/preambles';

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

const editedDefinition = {
	enabled: true,
	title: 'Edited preamble a',
	content: 'Edited content a',
	scope: { type: 'global' as const },
};

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

		await expect(store.update('a', editedDefinition, 3)).rejects.toBe(conflict);

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

		const updating = store.update('a', editedDefinition, 3);
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

		const updating = store.update('a', editedDefinition, 3);
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

		const updating = store.update('a', editedDefinition, 3);
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

	it('ignores a stale overtaken refresh and preserves newer state when an overtaken refresh fails', async () => {
		let resolveOvertaken!: (value: PreamblesSnapshot) => void;
		let rejectOvertaken!: (error: Error) => void;
		const get = vi
			.fn()
			.mockImplementationOnce(
				() => new Promise<PreamblesSnapshot>((resolve) => { resolveOvertaken = resolve; }),
			)
			.mockImplementationOnce(
				() => new Promise<PreamblesSnapshot>((_resolve, reject) => { rejectOvertaken = reject; }),
			);
		const store = new PreamblesStore({ get });
		store.applySnapshot(snapshot(1, ['a']));

		const overtaken = store.refresh();
		store.applySnapshot(snapshot(4, ['a', 'b', 'c']));
		resolveOvertaken(snapshot(2, ['a', 'b']));
		await expect(overtaken).resolves.toEqual(snapshot(4, ['a', 'b', 'c']));
		expect(store.snapshot).toEqual(snapshot(4, ['a', 'b', 'c']));

		const failingOvertaken = store.refresh().catch((error) => error);
		store.applySnapshot(snapshot(5, ['a', 'b', 'c', 'd']));
		const readError = new Error('network blip');
		rejectOvertaken(readError);
		expect(await failingOvertaken).toBe(readError);
		expect(store.snapshot).toEqual(snapshot(5, ['a', 'b', 'c', 'd']));
		expect(store.error).toBeNull();
		expect(store.status).toBe('ready');
	});

	it('serializes concurrent failed reorders back to the confirmed order', async () => {
		const rejectors: Array<(error: Error) => void> = [];
		const firstFailure = new Error('first failed');
		const secondFailure = new Error('second failed');
		const reorder = vi.fn(
			() =>
				new Promise<{ success: true; snapshot: PreamblesSnapshot }>((_resolve, reject) => {
					rejectors.push(reject);
				}),
		);
		const store = new PreamblesStore({ reorder });
		store.applySnapshot(snapshot(1, ['a', 'b', 'c']));

		const firstMove = store.move('c', 'up');
		await vi.waitFor(() => expect(reorder).toHaveBeenCalledTimes(1));
		const secondMove = store.move('c', 'up');
		await Promise.resolve();
		await Promise.resolve();
		expect(reorder).toHaveBeenCalledTimes(1);
		expect(store.preambles.map((entry) => entry.id)).toEqual(['a', 'c', 'b']);

		rejectors[0]!(firstFailure);
		await expect(firstMove).rejects.toBe(firstFailure);
		await vi.waitFor(() => expect(reorder).toHaveBeenCalledTimes(2));
		rejectors[1]!(secondFailure);
		await expect(secondMove).rejects.toBe(secondFailure);

		expect(store.preambles.map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
	});

	it('queues a second move to use the revision and order acknowledged by the first move', async () => {
		const resolvers: Array<(value: { success: true; snapshot: PreamblesSnapshot }) => void> = [];
		const reorder = vi.fn(
			() =>
				new Promise<{ success: true; snapshot: PreamblesSnapshot }>((resolve) => {
					resolvers.push(resolve);
				}),
		);
		const store = new PreamblesStore({ reorder });
		store.applySnapshot(snapshot(1, ['a', 'b', 'c']));

		const firstMove = store.move('c', 'up');
		await vi.waitFor(() => expect(reorder).toHaveBeenCalledTimes(1));
		const secondMove = store.move('c', 'up');
		await Promise.resolve();
		await Promise.resolve();
		expect(reorder).toHaveBeenCalledTimes(1);
		expect(reorder).toHaveBeenNthCalledWith(1, {
			expectedRevision: 1,
			orderedPreambleIds: ['a', 'c', 'b'],
		});

		resolvers[0]!({ success: true, snapshot: snapshot(2, ['a', 'c', 'b']) });
		await firstMove;
		await vi.waitFor(() => expect(reorder).toHaveBeenCalledTimes(2));
		expect(reorder).toHaveBeenNthCalledWith(2, {
			expectedRevision: 2,
			orderedPreambleIds: ['c', 'a', 'b'],
		});

		resolvers[1]!({ success: true, snapshot: snapshot(3, ['c', 'a', 'b']) });
		await secondMove;
		expect(store.snapshot).toEqual(snapshot(3, ['c', 'a', 'b']));
	});

	it('forwards caller-supplied expectedRevision on remove', async () => {
		const remove = vi.fn().mockResolvedValue({ success: true, snapshot: snapshot(5, []) });
		const store = new PreamblesStore({ remove });
		store.applySnapshot(snapshot(4, ['a']));

		await store.remove('a', 2);

		expect(remove).toHaveBeenCalledWith({ expectedRevision: 2, id: 'a' });
	});

	it('refreshes on PREAMBLE_NOT_FOUND while preserving the original error', async () => {
		const notFound = new ApiError(404, 'Preamble not found', PREAMBLE_ERROR_CODES.notFound);
		const get = vi.fn().mockResolvedValueOnce(snapshot(1, []));
		const remove = vi.fn().mockRejectedValueOnce(notFound);
		const store = new PreamblesStore({ get, remove });
		store.applySnapshot(snapshot(1, ['a']));

		await expect(store.remove('a', 1)).rejects.toBe(notFound);
		expect(get).toHaveBeenCalledOnce();
		expect(store.snapshot).toEqual(snapshot(1, []));
		expect(store.status).toBe('ready');
	});

	it('preserves a newer GET snapshot when a concurrent failed move overlaps it', async () => {
		const networkError = new Error('network failed');
		const get1 = Promise.withResolvers<PreamblesSnapshot>();
		const get2 = Promise.withResolvers<PreamblesSnapshot>();
		const reorder1 = Promise.withResolvers<{ success: true; snapshot: PreamblesSnapshot }>();
		const reorder2 = Promise.withResolvers<{ success: true; snapshot: PreamblesSnapshot }>();
		const get = vi.fn().mockReturnValueOnce(get1.promise).mockReturnValueOnce(get2.promise);
		const reorder = vi.fn().mockReturnValueOnce(reorder1.promise).mockReturnValueOnce(reorder2.promise);
		const store = new PreamblesStore({ get, reorder });
		store.applySnapshot(snapshot(3, ['a', 'b']));

		// Case 1: GET settles on the synchronous turn of move() before reorder settles.
		const refreshing1 = store.refresh();
		const moving1 = store.move('b', 'up');
		get1.resolve(snapshot(4, ['a', 'b', 'c']));
		await refreshing1;
		await vi.waitFor(() => expect(reorder).toHaveBeenCalledTimes(1));
		reorder1.reject(networkError);
		await expect(moving1).rejects.toBe(networkError);
		expect(store.snapshot).toEqual(snapshot(4, ['a', 'b', 'c']));

		// Case 2: GET settles while reorder is already in flight before reorder fails.
		const moving2 = store.move('b', 'up');
		await vi.waitFor(() => expect(reorder).toHaveBeenCalledTimes(2));
		const refreshing2 = store.refresh();
		get2.resolve(snapshot(5, ['a', 'b', 'c', 'd']));
		await refreshing2;
		reorder2.reject(networkError);
		await expect(moving2).rejects.toBe(networkError);
		expect(store.snapshot).toEqual(snapshot(5, ['a', 'b', 'c', 'd']));
	});
});
