import { describe, expect, it, vi } from 'vitest';
import type { ApiProviderManagement } from '$shared/api-providers';
import { ApiProvidersStore } from '../api-providers-store.svelte';

const snapshot = (revision = 1): ApiProviderManagement => ({
	providers: [], assignments: { revision, assignments: { local: ['profile_one'] } },
});

function fixture() {
	const api = { read: vi.fn(async () => snapshot()), delete: vi.fn(async () => ({ success: true })) };
	const invalidate = vi.fn();
	return { api, invalidate, store: new ApiProvidersStore(invalidate, api) };
}

describe('ApiProvidersStore', () => {
	it('coalesces reads, fences pre-mutation responses, and refreshes only retained consumers', async () => {
		const { api, invalidate, store } = fixture();
		const pending = Promise.withResolvers<ApiProviderManagement>();
		api.read.mockReturnValueOnce(pending.promise).mockResolvedValue(snapshot(2));
		const release = store.retain();
		const first = store.refresh();
		expect(api.read).toHaveBeenCalledTimes(1);
		store.invalidate();
		await store.refresh();
		expect(store.snapshot?.assignments.revision).toBe(2);
		pending.resolve(snapshot(1));
		await first;
		expect(store.snapshot?.assignments.revision).toBe(2);
		expect(store.loading).toBe(false);
		release();
		store.invalidate();
		expect(api.read).toHaveBeenCalledTimes(2);
		expect(invalidate).toHaveBeenCalledTimes(2);
	});

	it('returns an independent list of persisted executors for each profile', async () => {
		const { store } = fixture();
		await store.refresh();
		const executorIds = store.executorIdsFor('profile_one');
		expect(executorIds).toEqual(['local']);
		expect(store.executorIdsFor('missing')).toEqual([]);
		executorIds.pop();
		expect(store.executorIdsFor('profile_one')).toEqual(['local']);
		expect(store.isAssigned('local', 'profile_one')).toBe(true);
	});

	it('reconciles uncertain failures while retaining the error instead of claiming success', async () => {
		const { api, invalidate, store } = fixture();
		api.delete.mockRejectedValue(new Error('Durability unknown'));
		await store.deleteProfile('profile_one');
		expect(api.read).toHaveBeenCalledOnce();
		expect(invalidate).toHaveBeenCalledOnce();
		expect(store.error).toBe('Durability unknown');
		expect(store.mutating).toBe(false);
	});
});
