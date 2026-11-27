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

	it('forwards captured expectedRevision on update and remove even when store snapshot advances', async () => {
		const update = vi.fn().mockResolvedValue({ success: true, snapshot: snapshot(4, ['a']) });
		const remove = vi.fn().mockResolvedValue({ success: true, snapshot: snapshot(5, []) });
		const store = new SnippetsStore({ update, remove });
		store.applySnapshot(snapshot(3, ['a']));

		const definition = { shortName: 'a', template: 'Updated a', defaultArguments: '' };
		await store.update('a', definition, 2);
		expect(update).toHaveBeenCalledExactlyOnceWith({
			expectedRevision: 2,
			id: 'a',
			snippet: definition,
		});
		expect(store.snapshot).toEqual(snapshot(4, ['a']));

		await store.remove('a', 3);
		expect(remove).toHaveBeenCalledExactlyOnceWith({
			expectedRevision: 3,
			id: 'a',
		});
		expect(store.snapshot).toEqual(snapshot(5, []));
	});

	it('refreshes on revision conflicts for create, update, and remove while preserving the rejection', async () => {
		const conflict = new ApiError(409, 'revision conflict', SNIPPET_ERROR_CODES.revisionConflict);
		const get = vi
			.fn<() => Promise<SnippetsSnapshot>>()
			.mockResolvedValueOnce(snapshot(3, ['a', 'b']))
			.mockResolvedValueOnce(snapshot(4, ['a', 'b']))
			.mockResolvedValueOnce(snapshot(5, ['a']));
		const create = vi.fn().mockRejectedValue(conflict);
		const update = vi.fn().mockRejectedValue(conflict);
		const remove = vi.fn().mockRejectedValue(conflict);
		const store = new SnippetsStore({ get, create, update, remove });
		store.applySnapshot(snapshot(2, ['a']));

		await expect(
			store.create({ shortName: 'b', template: 'Template b', defaultArguments: '' }),
		).rejects.toBe(conflict);
		expect(get).toHaveBeenCalledTimes(1);
		expect(store.snapshot).toEqual(snapshot(3, ['a', 'b']));

		await expect(
			store.update('a', { shortName: 'a', template: 'Updated', defaultArguments: '' }, 2),
		).rejects.toBe(conflict);
		expect(get).toHaveBeenCalledTimes(2);
		expect(store.snapshot).toEqual(snapshot(4, ['a', 'b']));

		await expect(store.remove('a', 3)).rejects.toBe(conflict);
		expect(get).toHaveBeenCalledTimes(3);
		expect(store.snapshot).toEqual(snapshot(5, ['a']));
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
});
