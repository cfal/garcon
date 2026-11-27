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

	it('installs an authoritative lower-revision refresh when nothing overtook it', async () => {
		const get = vi.fn().mockResolvedValue(snapshot(1, ['a']));
		const create = vi.fn().mockResolvedValue({ success: true, snapshot: snapshot(2, ['a', 'c']) });
		const store = new SnippetsStore({ get, create });
		store.applySnapshot(snapshot(3, ['a', 'b']));

		await store.refresh();

		expect(store.snapshot).toEqual(snapshot(1, ['a']));
		await store.create({ shortName: 'c', template: 'Template c', defaultArguments: '' });
		expect(create).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 1 }));
	});

	it('ignores a stale overtaken refresh and preserves newer state when an overtaken refresh fails', async () => {
		let resolveRead!: (value: SnippetsSnapshot) => void;
		let rejectRead!: (error: Error) => void;
		const get = vi
			.fn()
			.mockImplementationOnce(() => new Promise<SnippetsSnapshot>((resolve) => { resolveRead = resolve; }))
			.mockImplementationOnce(
				() => new Promise<SnippetsSnapshot>((_resolve, reject) => { rejectRead = reject; }),
			);
		const store = new SnippetsStore({ get });
		store.applySnapshot(snapshot(1, ['a']));

		const firstRefresh = store.refresh();
		store.applySnapshot(snapshot(3, ['a', 'c']));
		resolveRead(snapshot(2, ['a', 'b']));
		await expect(firstRefresh).resolves.toEqual(snapshot(3, ['a', 'c']));
		expect(store.snapshot).toEqual(snapshot(3, ['a', 'c']));

		const failingRefresh = store.refresh().catch((error) => error);
		store.applySnapshot(snapshot(4, ['a', 'c', 'd']));
		const readError = new Error('network blip');
		rejectRead(readError);
		expect(await failingRefresh).toBe(readError);
		expect(store.snapshot).toEqual(snapshot(4, ['a', 'c', 'd']));
		expect(store.error).toBeNull();
		expect(store.status).toBe('ready');
	});

	it('performs a fresh read when conflict recovery joins a failing in-flight refresh', async () => {
		let rejectInitial!: (error: Error) => void;
		const readFailure = new Error('temporary failure');
		const conflict = new ApiError(409, 'revision conflict', SNIPPET_ERROR_CODES.revisionConflict);
		const get = vi
			.fn()
			.mockImplementationOnce(
				() => new Promise<SnippetsSnapshot>((_resolve, reject) => { rejectInitial = reject; }),
			)
			.mockResolvedValueOnce(snapshot(3, ['a', 'b']));
		const store = new SnippetsStore({ get, create: vi.fn().mockRejectedValue(conflict) });
		store.applySnapshot(snapshot(1, ['a']));

		const olderRefresh = store.refresh().catch((error) => error);
		const creating = store.create({
			shortName: 'b',
			template: 'Template b',
			defaultArguments: '',
		});
		await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1));
		rejectInitial(readFailure);

		expect(await olderRefresh).toBe(readFailure);
		await expect(creating).rejects.toBe(conflict);
		expect(get).toHaveBeenCalledTimes(2);
		expect(store.snapshot).toEqual(snapshot(3, ['a', 'b']));
	});

	it('forwards caller-supplied expectedRevision on update and remove', async () => {
		const update = vi.fn().mockResolvedValue({ success: true, snapshot: snapshot(6, ['a']) });
		const remove = vi.fn().mockResolvedValue({ success: true, snapshot: snapshot(7, []) });
		const store = new SnippetsStore({ update, remove });
		store.applySnapshot(snapshot(5, ['a']));

		await store.update('a', { shortName: 'a', template: 'Updated', defaultArguments: '' }, 2);
		await store.remove('a', 3);

		expect(update).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 2, id: 'a' }));
		expect(remove).toHaveBeenCalledWith({ expectedRevision: 3, id: 'a' });
	});

	it('reconciles instead of installing a late pre-restore write acknowledgement after a backwards refresh', async () => {
		let resolveUpdate!: (value: { success: true; snapshot: SnippetsSnapshot }) => void;
		const update = vi.fn(
			() =>
				new Promise<{ success: true; snapshot: SnippetsSnapshot }>((resolve) => {
					resolveUpdate = resolve;
				}),
		);
		const get = vi
			.fn()
			.mockResolvedValueOnce(snapshot(2, ['restored']))
			.mockResolvedValueOnce(snapshot(2, ['restored']));
		const store = new SnippetsStore({ get, update });
		store.applySnapshot(snapshot(8, ['old']));

		const updating = store.update(
			'old',
			{ shortName: 'old', template: 'Pre-restore edit', defaultArguments: '' },
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
		let resolveUpdate!: (value: { success: true; snapshot: SnippetsSnapshot }) => void;
		let resolveRefresh!: (value: SnippetsSnapshot) => void;
		const update = vi.fn(
			() =>
				new Promise<{ success: true; snapshot: SnippetsSnapshot }>((resolve) => {
					resolveUpdate = resolve;
				}),
		);
		const get = vi
			.fn()
			.mockImplementationOnce(
				() => new Promise<SnippetsSnapshot>((resolve) => { resolveRefresh = resolve; }),
			)
			.mockResolvedValueOnce(snapshot(2, ['restored']));
		const store = new SnippetsStore({ get, update });
		store.applySnapshot(snapshot(8, ['old']));

		const updating = store.update(
			'old',
			{ shortName: 'old', template: 'Pre-restore edit', defaultArguments: '' },
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
		let resolveUpdate!: (value: { success: true; snapshot: SnippetsSnapshot }) => void;
		const update = vi.fn(
			() =>
				new Promise<{ success: true; snapshot: SnippetsSnapshot }>((resolve) => {
					resolveUpdate = resolve;
				}),
		);
		const get = vi
			.fn()
			.mockResolvedValueOnce(snapshot(8, ['restored']))
			.mockResolvedValueOnce(snapshot(8, ['restored']));
		const store = new SnippetsStore({ get, update });
		store.applySnapshot(snapshot(8, ['old']));

		const updating = store.update(
			'old',
			{ shortName: 'old', template: 'Pre-restore edit', defaultArguments: '' },
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
		let resolveRemove!: (value: { success: true; snapshot: SnippetsSnapshot }) => void;
		const remove = vi.fn(
			() =>
				new Promise<{ success: true; snapshot: SnippetsSnapshot }>((resolve) => {
					resolveRemove = resolve;
				}),
		);
		const get = vi
			.fn()
			.mockResolvedValueOnce(snapshot(1, ['a']))
			.mockRejectedValueOnce(new Error('network down'))
			.mockResolvedValueOnce(snapshot(2, []));
		const store = new SnippetsStore({ get, remove });
		store.applySnapshot(snapshot(1, ['a']));

		const removing = store.remove('a', 1);
		await vi.waitFor(() => expect(remove).toHaveBeenCalledOnce());
		await store.refresh();

		resolveRemove({ success: true, snapshot: snapshot(2, []) });
		await expect(removing).resolves.toEqual(snapshot(2, []));

		expect(store.hasLoaded).toBe(false);
		expect(store.snapshot).toBeNull();
		expect(store.snippets).toEqual([]);
		expect(store.status).toBe('error');

		await store.ensureLoaded();
		expect(get).toHaveBeenCalledTimes(3);
		expect(store.hasLoaded).toBe(true);
		expect(store.snapshot).toEqual(snapshot(2, []));
		expect(store.status).toBe('ready');
	});

	it('invalidates when a write ack overlaps an in-flight GET whose follow-up read fails', async () => {
		let resolveRemove!: (value: { success: true; snapshot: SnippetsSnapshot }) => void;
		let resolveInitialRefresh!: (value: SnippetsSnapshot) => void;
		const remove = vi.fn(
			() =>
				new Promise<{ success: true; snapshot: SnippetsSnapshot }>((resolve) => {
					resolveRemove = resolve;
				}),
		);
		const get = vi
			.fn()
			.mockImplementationOnce(
				() => new Promise<SnippetsSnapshot>((resolve) => { resolveInitialRefresh = resolve; }),
			)
			.mockRejectedValueOnce(new Error('follow-up failed'));
		const store = new SnippetsStore({ get, remove });
		store.applySnapshot(snapshot(1, ['a']));

		const refreshing = store.refresh();
		const removing = store.remove('a', 1);
		await vi.waitFor(() => expect(remove).toHaveBeenCalledOnce());

		resolveRemove({ success: true, snapshot: snapshot(2, []) });
		await Promise.resolve();
		await Promise.resolve();
		resolveInitialRefresh(snapshot(1, ['a']));

		await refreshing;
		await expect(removing).resolves.toEqual(snapshot(2, []));
		expect(get).toHaveBeenCalledTimes(2);
		expect(store.hasLoaded).toBe(false);
		expect(store.snapshot).toBeNull();
		expect(store.snippets).toEqual([]);
		expect(store.status).toBe('error');
	});
});
