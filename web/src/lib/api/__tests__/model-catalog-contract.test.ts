import { afterEach, expect, it, vi } from 'vitest';
import { onAuthRejection, retainAuthToken } from '$lib/auth/session';
import { createModelCatalogStore } from '$lib/agents/model-catalog-store.svelte';

afterEach(() => vi.unstubAllGlobals());

it('retains an actionable error when an intermediary returns an empty status description', async () => {
	retainAuthToken('catalog-token');
	vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 503 })));
	const catalog = createModelCatalogStore();
	await catalog.forceRefresh();
	expect(catalog.error).toBe('Failed to fetch model catalog: 503');
});

it('reports catalog-only auth rejection through the shared HTTP boundary', async () => {
	retainAuthToken('catalog-token');
	const rejected = vi.fn();
	const unsubscribe = onAuthRejection(rejected);
	vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({
		success: false, error: 'Sign in again', errorCode: 'AUTH_SESSION_INVALID', retryable: false,
	}, { status: 401 })));
	try {
		const catalog = createModelCatalogStore();
		await catalog.forceRefresh();
		expect(catalog.error).toBe('Sign in again');
		expect(rejected).toHaveBeenCalledExactlyOnceWith({ token: 'catalog-token', code: 'AUTH_SESSION_INVALID' });
	} finally {
		unsubscribe();
	}
});
