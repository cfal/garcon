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
		createdAt: '2029-01-01T00:00:00.000Z',
		updatedAt: '2029-01-01T00:00:00.000Z',
	};
}

function snapshot(revision: number, ids: string[]): SnippetsSnapshot {
	return { revision, snippets: ids.map(snippet) };
}

describe('SnippetsStore', () => {
	it('loads lazily and applies canonical mutation snapshots', async () => {
		const get = vi.fn().mockResolvedValue(snapshot(0, []));
		const create = vi.fn().mockResolvedValue({ success: true, snapshot: snapshot(1, ['a']) });
		const store = new SnippetsStore({ get, create });
		expect(get).not.toHaveBeenCalled();

		await store.ensureLoaded();
		await store.create({ shortName: 'a', template: 'Template a' });

		expect(create).toHaveBeenCalledWith({
			expectedRevision: 0,
			snippet: { shortName: 'a', template: 'Template a' },
		});
		expect(store.snapshot).toEqual(snapshot(1, ['a']));
	});

	it('refreshes after a revision conflict and preserves the original rejection', async () => {
		const conflict = new ApiError(409, 'revision conflict', SNIPPET_ERROR_CODES.revisionConflict);
		const get = vi.fn().mockResolvedValue(snapshot(3, ['a', 'b']));
		const create = vi.fn().mockRejectedValue(conflict);
		const store = new SnippetsStore({ get, create });
		store.applySnapshot(snapshot(2, ['a']));

		await expect(store.create({ shortName: 'b', template: 'Template b' })).rejects.toBe(conflict);

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
		const creating = store.create({ shortName: 'b', template: 'Template b' });

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

		await expect(store.create({ shortName: 'a', template: 'Other' })).rejects.toBe(conflict);

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
});
