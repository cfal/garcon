import { describe, expect, it, vi } from 'vitest';
import type { ApiProviderManagement } from '$shared/api-providers';
import { ApiProvidersStore } from '../api-providers-store.svelte';

const snapshot = (revision = 1): ApiProviderManagement => ({
	providers: [], assignments: { revision, assignments: { local: ['profile_one'] } },
});

function fixture() {
	const api = { read: vi.fn(async () => snapshot()), assign: vi.fn(async () => snapshot()),
		unassign: vi.fn(async () => snapshot()), delete: vi.fn(async () => ({ success: true })) };
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

	it('sends narrow idempotent assignments without replacing the snapshot optimistically', async () => {
		const { api, store } = fixture();
		await store.refresh();
		const pending = Promise.withResolvers<ApiProviderManagement>();
		api.unassign.mockReturnValue(pending.promise);
		api.read.mockResolvedValue({ ...snapshot(2), assignments: { revision: 2, assignments: {} } });
		const mutation = store.setAssignment('local', 'profile_one', false);
		expect(store.isAssigned('local', 'profile_one')).toBe(true);
		expect(store.mutating).toBe(true);
		pending.resolve(snapshot(2));
		await mutation;
		expect(api.unassign).toHaveBeenCalledWith('local', 'profile_one');
		expect(store.isAssigned('local', 'profile_one')).toBe(false);
		expect(store.mutating).toBe(false);
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
