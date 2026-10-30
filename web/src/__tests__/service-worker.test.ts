import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	withNavigationTimeout,
	isManifestPath,
	precacheAppShell,
	preserveCachedFonts,
	shouldCacheNavigationResponse,
} from '../service-worker-helpers';

describe('service worker helpers', () => {
	it('inherits only requested immutable fonts and preserves current responses', async () => {
		const currentResponse = new Response('current');
		const inherited = new Response('previous');
		const current = {
			match: vi
				.fn<Cache['match']>()
				.mockImplementation(async (path) => (path === '/kept.woff2' ? currentResponse : undefined)),
			put: vi.fn<Cache['put']>().mockResolvedValue(undefined),
		} satisfies Pick<Cache, 'match' | 'put'>;
		const previous = {
			match: vi
				.fn<Cache['match']>()
				.mockImplementation(async (path) => (path === '/used.woff2' ? inherited : undefined)),
		} satisfies Pick<Cache, 'match'>;
		await preserveCachedFonts(current, previous, {
			build: ['/kept.woff2', '/used.woff2', '/unused.woff2', '/app.js'],
			files: ['/unversioned.woff2'],
		});
		expect(previous.match.mock.calls.map(([path]) => path)).toEqual([
			'/used.woff2',
			'/unused.woff2',
		]);
		expect(current.put).toHaveBeenCalledExactlyOnceWith('/used.woff2', inherited);
	});

	it('propagates migration failure so activation retains the donor cache', async () => {
		const current = {
			match: vi.fn<Cache['match']>().mockResolvedValue(undefined),
			put: vi.fn<Cache['put']>().mockRejectedValue(new Error('quota')),
		} satisfies Pick<Cache, 'match' | 'put'>;
		const previous = {
			match: vi.fn<Cache['match']>().mockResolvedValue(new Response('font')),
		} satisfies Pick<Cache, 'match'>;
		await expect(
			preserveCachedFonts(current, previous, { build: ['/used.woff2'], files: [] }),
		).rejects.toThrow('quota');
	});
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

	it('leaves both immutable and static fonts to demand loading under a runtime mount', async () => {
		const addAll = vi.fn<Cache['addAll']>().mockResolvedValue(undefined);
		const add = vi.fn<Cache['add']>().mockResolvedValue(undefined);
		await precacheAppShell(
			{ addAll, add },
			{
				build: [
					'/mounted/_app/app.js',
					'/mounted/_app/Inter-core.woff2',
					'/mounted/_app/Inter-extended.woff2',
				],
				files: [
					'/mounted/font.woff',
					'/mounted/font.ttf',
					'/mounted/font.otf',
					'/mounted/icon.svg',
				],
			},
			'/mounted',
		);
		expect(addAll).toHaveBeenCalledExactlyOnceWith(['/mounted/', '/mounted/_app/app.js']);
		expect(add).toHaveBeenCalledExactlyOnceWith('/mounted/icon.svg');
	});

	it('recognizes manifest paths for cache bypass', () => {
		expect(isManifestPath('/site.webmanifest')).toBe(true);
		expect(isManifestPath('https://garcon.test/site.webmanifest')).toBe(true);
		expect(isManifestPath('/icon.svg')).toBe(false);
	});

	it('keeps framework-prefixed assets and manifest filtering under the mount', async () => {
		const addAll = vi.fn<Cache['addAll']>().mockResolvedValue(undefined);
		const add = vi.fn<Cache['add']>().mockResolvedValue(undefined);
		await precacheAppShell(
			{ addAll, add },
			{
				build: ['/tools/garcon/_app/app.js'],
				files: ['/tools/garcon/site.webmanifest', '/tools/garcon/icons/icon.svg'],
			},
			'/tools/garcon',
		);
		expect(addAll).toHaveBeenCalledWith(['/tools/garcon/', '/tools/garcon/_app/app.js']);
		expect(add).toHaveBeenCalledExactlyOnceWith('/tools/garcon/icons/icon.svg');
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
