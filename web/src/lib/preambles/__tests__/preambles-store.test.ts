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

	it('installs an authoritative lower-revision refresh and ignores overtaken refreshes', async () => {
		let resolveOvertaken!: (value: PreamblesSnapshot) => void;
		const get = vi
			.fn()
			.mockResolvedValueOnce(snapshot(1, ['a']))
			.mockImplementationOnce(
				() => new Promise<PreamblesSnapshot>((resolve) => { resolveOvertaken = resolve; }),
			);
		const store = new PreamblesStore({ get });
		store.applySnapshot(snapshot(3, ['a', 'b']));

		await store.refresh();
		expect(store.snapshot).toEqual(snapshot(1, ['a']));

		const overtaken = store.refresh();
		store.applySnapshot(snapshot(4, ['a', 'b', 'c']));
		resolveOvertaken(snapshot(2, ['a', 'b']));
		await expect(overtaken).resolves.toEqual(snapshot(4, ['a', 'b', 'c']));
		expect(store.snapshot).toEqual(snapshot(4, ['a', 'b', 'c']));
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

	it('reconciles instead of installing a late pre-restore write acknowledgement after a backwards refresh', async () => {
		let resolveUpdate!: (value: { success: true; snapshot: PreamblesSnapshot }) => void;
		const update = vi.fn(
			() =>
				new Promise<{ success: true; snapshot: PreamblesSnapshot }>((resolve) => {
					resolveUpdate = resolve;
				}),
		);
		const get = vi
			.fn()
			.mockResolvedValueOnce(snapshot(2, ['restored']))
			.mockResolvedValueOnce(snapshot(2, ['restored']));
		const store = new PreamblesStore({ get, update });
		store.applySnapshot(snapshot(8, ['a']));

		const updating = store.update(
			'a',
			{
				enabled: true,
				title: 'Pre-restore edit',
				content: 'Pre-restore body',
				scope: { type: 'global' },
			},
			8,
		);
		await vi.waitFor(() => expect(update).toHaveBeenCalledOnce());

		await store.refresh();
		expect(store.snapshot).toEqual(snapshot(2, ['restored']));

		resolveUpdate({ success: true, snapshot: snapshot(9, ['pre-restore']) });
		await updating;

		expect(get).toHaveBeenCalledTimes(2);
		expect(store.snapshot).toEqual(snapshot(2, ['restored']));
		expect(store.status).toBe('ready');
	});

	it('reconciles when a pre-restore write ack arrives before an in-flight restore refresh completes', async () => {
		let resolveUpdate!: (value: { success: true; snapshot: PreamblesSnapshot }) => void;
		let resolveRefresh!: (value: PreamblesSnapshot) => void;
		const update = vi.fn(
			() =>
				new Promise<{ success: true; snapshot: PreamblesSnapshot }>((resolve) => {
					resolveUpdate = resolve;
				}),
		);
		const get = vi
			.fn()
			.mockImplementationOnce(
				() => new Promise<PreamblesSnapshot>((resolve) => { resolveRefresh = resolve; }),
			)
			.mockResolvedValueOnce(snapshot(2, ['restored']));
		const store = new PreamblesStore({ get, update });
		store.applySnapshot(snapshot(8, ['a']));

		const updating = store.update(
			'a',
			{
				enabled: true,
				title: 'Pre-restore edit',
				content: 'Pre-restore body',
				scope: { type: 'global' },
			},
			8,
		);
		await vi.waitFor(() => expect(update).toHaveBeenCalledOnce());

		const refreshing = store.refresh();
		resolveUpdate({ success: true, snapshot: snapshot(9, ['pre-restore']) });
		await Promise.resolve();
		await Promise.resolve();
		resolveRefresh(snapshot(2, ['restored']));

		await Promise.all([refreshing, updating]);
		expect(get).toHaveBeenCalledTimes(2);
		expect(store.snapshot).toEqual(snapshot(2, ['restored']));
	});

	it('reconciles when a same-revision restore refresh installs different content before a late write ack', async () => {
		let resolveUpdate!: (value: { success: true; snapshot: PreamblesSnapshot }) => void;
		const update = vi.fn(
			() =>
				new Promise<{ success: true; snapshot: PreamblesSnapshot }>((resolve) => {
					resolveUpdate = resolve;
				}),
		);
		const get = vi
			.fn()
			.mockResolvedValueOnce(snapshot(8, ['restored']))
			.mockResolvedValueOnce(snapshot(8, ['restored']));
		const store = new PreamblesStore({ get, update });
		store.applySnapshot(snapshot(8, ['a']));

		const updating = store.update(
			'a',
			{
				enabled: true,
				title: 'Pre-restore edit',
				content: 'Pre-restore body',
				scope: { type: 'global' },
			},
			8,
		);
		await vi.waitFor(() => expect(update).toHaveBeenCalledOnce());

		await store.refresh();
		resolveUpdate({ success: true, snapshot: snapshot(9, ['pre-restore']) });
		await updating;

		expect(get).toHaveBeenCalledTimes(2);
		expect(store.snapshot).toEqual(snapshot(8, ['restored']));
	});

	it('invalidates the snapshot for local expansion when post-write reconciliation fails, then recovers on next demand', async () => {
		let resolveRemove!: (value: { success: true; snapshot: PreamblesSnapshot }) => void;
		const remove = vi.fn(
			() =>
				new Promise<{ success: true; snapshot: PreamblesSnapshot }>((resolve) => {
					resolveRemove = resolve;
				}),
		);
		const get = vi
			.fn()
			.mockResolvedValueOnce(snapshot(1, ['a']))
			.mockRejectedValueOnce(new Error('network down'))
			.mockResolvedValueOnce(snapshot(2, []));
		const store = new PreamblesStore({ get, remove });
		store.applySnapshot(snapshot(1, ['a']));

		const removing = store.remove('a', 1);
		await vi.waitFor(() => expect(remove).toHaveBeenCalledOnce());
		await store.refresh();

		resolveRemove({ success: true, snapshot: snapshot(2, []) });
		await expect(removing).resolves.toEqual(snapshot(2, []));

		expect(store.hasLoaded).toBe(false);
		expect(store.snapshot).toBeNull();
		expect(store.preambles).toEqual([]);
		expect(store.status).toBe('error');

		await store.ensureLoaded();
		expect(get).toHaveBeenCalledTimes(3);
		expect(store.hasLoaded).toBe(true);
		expect(store.snapshot).toEqual(snapshot(2, []));
		expect(store.status).toBe('ready');
	});
});
