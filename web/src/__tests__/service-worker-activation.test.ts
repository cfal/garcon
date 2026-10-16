import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/env', () => ({ version: 'current' }));
vi.mock('$app/manifest', () => ({
	immutable: [{ path: '_app/immutable/entry/start.js' }],
	assets: [{ path: 'icons/app.png' }, { path: 'site.webmanifest' }],
}));

describe('service worker activation', () => {
	beforeEach(() => {
		vi.resetModules();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it.each(['', '/tools/garcon'])(
		'removes obsolete caches owned by mount "%s" before claiming clients',
		async (basePath) => {
			const prefix = `garcon:${encodeURIComponent(basePath)}:`;
			const names = [
				`${prefix}current`,
				`${prefix}outdated`,
				'garcon-pre-prefix-version',
				'garcon:%2Fother:outdated',
				'unrelated',
			];
			const pendingDelete = Promise.withResolvers<boolean>();
			const storage = {
				keys: vi.fn<CacheStorage['keys']>().mockResolvedValue(names),
				delete: vi.fn<CacheStorage['delete']>().mockReturnValue(pendingDelete.promise),
			} satisfies Pick<CacheStorage, 'keys' | 'delete'>;
			const claim = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
			const scope = new EventTarget();
			vi.stubGlobal('self', {
				registration: { scope: `https://garcon.test${basePath}/` },
				addEventListener: scope.addEventListener.bind(scope),
				clients: { claim },
			});
			vi.stubGlobal('caches', storage);
			await vi.importActual('../service-worker/index.js');
			const lifetimes: Promise<unknown>[] = [];
			scope.dispatchEvent(
				Object.assign(new Event('activate'), {
					waitUntil: (promise: Promise<unknown>) => lifetimes.push(promise),
				}),
			);

			await vi.waitFor(() => expect(storage.delete).toHaveBeenCalled());
			const deleted = [`${prefix}outdated`];
			if (basePath === '') deleted.push('garcon-pre-prefix-version');
			expect(storage.delete.mock.calls.map(([name]) => name)).toEqual(deleted);
			expect(claim).not.toHaveBeenCalled();
			expect(lifetimes).toHaveLength(1);

			pendingDelete.resolve(true);
			await lifetimes[0];
			expect(claim).toHaveBeenCalledOnce();
		},
	);

	it.each(['', '/tools/garcon'])(
		'precaches Kit 3 manifest paths at mount "%s"',
		async (basePath) => {
			const cache = {
				addAll: vi.fn<Cache['addAll']>().mockResolvedValue(undefined),
				add: vi.fn<Cache['add']>().mockResolvedValue(undefined),
			} satisfies Pick<Cache, 'addAll' | 'add'>;
			const scope = new EventTarget();
			const skipWaiting = vi.fn().mockResolvedValue(undefined);
			vi.stubGlobal('self', {
				registration: { scope: `https://garcon.test${basePath}/` },
				addEventListener: scope.addEventListener.bind(scope),
				skipWaiting,
			});
			vi.stubGlobal('caches', { open: vi.fn().mockResolvedValue(cache) });
			await vi.importActual('../service-worker/index.js');
			const lifetimes: Promise<unknown>[] = [];
			scope.dispatchEvent(
				Object.assign(new Event('install'), {
					waitUntil: (promise: Promise<unknown>) => lifetimes.push(promise),
				}),
			);
			await Promise.all(lifetimes);
			expect(cache.addAll).toHaveBeenCalledWith([
				`${basePath}/`,
				`${basePath}/_app/immutable/entry/start.js`,
			]);
			expect(cache.add).toHaveBeenCalledExactlyOnceWith(`${basePath}/icons/app.png`);
			expect(skipWaiting).toHaveBeenCalledOnce();
		},
	);
});
