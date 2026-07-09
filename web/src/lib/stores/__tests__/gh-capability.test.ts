import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GhCapabilityStore } from '../gh-capability.svelte';
import * as ghApi from '$lib/api/gh';

vi.mock('$lib/api/gh', () => ({
	getGhStatus: vi.fn(),
}));

const getGhStatusMock = vi.mocked(ghApi.getGhStatus);

describe('GhCapabilityStore', () => {
	beforeEach(() => {
		vi.resetAllMocks();
	});

	it('starts unavailable before the first check', () => {
		const store = new GhCapabilityStore();

		expect(store.available).toBe(false);
		expect(store.authenticated).toBe(false);
		expect(store.hasChecked).toBe(false);
		expect(store.reason).toBe(null);
	});

	it('loads status once for ensureChecked', async () => {
		getGhStatusMock.mockResolvedValue({
			available: true,
			authenticated: true,
			reason: 'authenticated',
			login: 'octocat',
			host: 'github.com',
		});
		const store = new GhCapabilityStore();

		await store.ensureChecked();
		await store.ensureChecked();

		expect(getGhStatusMock).toHaveBeenCalledTimes(1);
		expect(store.available).toBe(true);
		expect(store.authenticated).toBe(true);
		expect(store.reason).toBe('authenticated');
		expect(store.login).toBe('octocat');
		expect(store.host).toBe('github.com');
	});

	it('shares an in-flight startup check', async () => {
		let resolveStatus: (() => void) | undefined;
		getGhStatusMock.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveStatus = () =>
						resolve({
							available: false,
							authenticated: false,
							reason: 'unauthenticated',
						});
				}),
		);
		const store = new GhCapabilityStore();

		const first = store.ensureChecked();
		const second = store.ensureChecked();
		resolveStatus?.();
		await Promise.all([first, second]);

		expect(getGhStatusMock).toHaveBeenCalledTimes(1);
		expect(store.available).toBe(false);
		expect(store.hasChecked).toBe(true);
	});

	it('refresh always re-fetches and can flip availability', async () => {
		getGhStatusMock
			.mockResolvedValueOnce({
				available: false,
				authenticated: false,
				reason: 'unauthenticated',
			})
			.mockResolvedValueOnce({
				available: true,
				authenticated: true,
				reason: 'authenticated',
				login: 'hubot',
				host: 'github.com',
			});
		const store = new GhCapabilityStore();

		await store.ensureChecked();
		await store.refresh();

		expect(getGhStatusMock).toHaveBeenCalledTimes(2);
		expect(store.available).toBe(true);
		expect(store.login).toBe('hubot');
	});

	it('fails closed when the status request fails', async () => {
		getGhStatusMock.mockRejectedValue(new Error('network down'));
		const store = new GhCapabilityStore();

		await store.ensureChecked();

		expect(store.available).toBe(false);
		expect(store.authenticated).toBe(false);
		expect(store.reason).toBe('unknown');
		expect(store.hasChecked).toBe(true);
		expect(store.lastError).toBe('network down');
	});
});
