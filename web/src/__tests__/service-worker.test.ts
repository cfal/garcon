import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	withNavigationTimeout,
	isManifestPath,
	precacheAppShell,
	shouldCacheNavigationResponse,
} from '../service-worker-helpers';

describe('service worker helpers', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it('pre-caches build assets strictly and static files tolerantly', async () => {
		const addAll = vi.fn<Cache['addAll']>().mockResolvedValue(undefined);
		const add = vi.fn<Cache['add']>((url) => {
			if (url === '/missing-static-file.png') {
				return Promise.reject(new Error('missing'));
			}
			return Promise.resolve();
		});

		await expect(
			precacheAppShell(
				{ addAll, add },
				{ build: ['/build/app.js'], files: ['/favicon.png', '/missing-static-file.png'] },
			),
		).resolves.toBeUndefined();

		expect(addAll).toHaveBeenCalledWith(['/', '/build/app.js']);
		expect(add).toHaveBeenCalledWith('/favicon.png');
		expect(add).toHaveBeenCalledWith('/missing-static-file.png');
	});

	it('does not precache the remote title manifest', async () => {
		const addAll = vi.fn<Cache['addAll']>().mockResolvedValue(undefined);
		const add = vi.fn<Cache['add']>().mockResolvedValue(undefined);

		await precacheAppShell(
			{ addAll, add },
			{
				build: ['/build/app.js'],
				files: ['/site.webmanifest', '/icon.svg'],
			},
		);

		expect(addAll).toHaveBeenCalledWith(['/', '/build/app.js']);
		expect(add).not.toHaveBeenCalledWith('/site.webmanifest');
		expect(add).toHaveBeenCalledWith('/icon.svg');
	});

	it('recognizes manifest paths for cache bypass', () => {
		expect(isManifestPath('/site.webmanifest')).toBe(true);
		expect(isManifestPath('https://garcon.test/site.webmanifest')).toBe(true);
		expect(isManifestPath('/icon.svg')).toBe(false);
	});

	it('does not cache navigation responses marked no-store', () => {
		const response = (cacheControl?: string) =>
			({
				ok: true,
				type: 'basic',
				headers: new Headers(cacheControl ? { 'Cache-Control': cacheControl } : undefined),
			}) as Response;

		expect(shouldCacheNavigationResponse(response())).toBe(true);
		expect(shouldCacheNavigationResponse(response('public, max-age=60'))).toBe(true);
		expect(shouldCacheNavigationResponse(response('private, NO-STORE'))).toBe(false);
	});

	it.each(['resolve', 'reject'] as const)(
		'keeps the navigation timeout result after a late network %s',
		async (outcome) => {
			vi.useFakeTimers();
			const network = Promise.withResolvers<Response>();
			const navigation = withNavigationTimeout(network.promise, 100);
			const timeoutExpectation = expect(navigation).rejects.toThrow('navigation timeout');

			await vi.advanceTimersByTimeAsync(100);
			await timeoutExpectation;

			if (outcome === 'resolve') {
				const response = new Response('late');
				network.resolve(response);
				await expect(network.promise).resolves.toBe(response);
			} else {
				const error = new Error('late failure');
				network.reject(error);
				await expect(network.promise).rejects.toBe(error);
			}
			await expect(navigation).rejects.toThrow('navigation timeout');
			expect(vi.getTimerCount()).toBe(0);
		},
	);

	it.each(['resolve', 'reject'] as const)(
		'clears the timeout after an early network %s',
		async (outcome) => {
			vi.useFakeTimers();
			const network = Promise.withResolvers<Response>();
			const navigation = withNavigationTimeout(network.promise);
			if (outcome === 'resolve') {
				const response = new Response('online');
				network.resolve(response);
				await expect(navigation).resolves.toBe(response);
			} else {
				const error = new Error('offline');
				network.reject(error);
				await expect(navigation).rejects.toBe(error);
			}
			expect(vi.getTimerCount()).toBe(0);
		},
	);
});
