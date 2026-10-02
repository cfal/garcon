import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FetchEventPort {
	request: Request;
	waitUntil(promise: Promise<unknown>): void;
	respondWith(response: Response | PromiseLike<Response>): void;
}

// Keeps the worker's global declarations outside the application's DOM type environment.
const installWorker = () => vi.importActual('../service-worker');

function harness() {
	const scope = new EventTarget();
	const cache = {
		match: vi.fn<Cache['match']>().mockResolvedValue(undefined),
		put: vi.fn<Cache['put']>().mockResolvedValue(undefined),
		add: vi.fn<Cache['add']>(),
		addAll: vi.fn<Cache['addAll']>(),
		delete: vi.fn<Cache['delete']>(),
		keys: vi.fn<Cache['keys']>(),
		matchAll: vi.fn<Cache['matchAll']>(),
	} satisfies Cache;
	const storage = {
		open: vi.fn<CacheStorage['open']>().mockResolvedValue(cache),
		match: vi.fn<CacheStorage['match']>().mockResolvedValue(new Response('offline')),
	} satisfies Pick<CacheStorage, 'open' | 'match'>;
	const network = vi.fn<typeof fetch>();
	vi.stubGlobal('self', {
		addEventListener: scope.addEventListener.bind(scope),
		location: { origin: 'https://garcon.test' },
	});
	vi.stubGlobal('caches', storage);
	vi.stubGlobal('fetch', network);

	function dispatch(path: string, navigate = false) {
		const request = new Request(`https://garcon.test${path}`);
		if (navigate) Object.defineProperty(request, 'mode', { value: 'navigate' });
		const lifetimes: Promise<unknown>[] = [];
		const responses: Promise<Response>[] = [];
		let dispatching = true;
		const event = Object.assign(new Event('fetch'), {
			request,
			waitUntil(promise: Promise<unknown>) {
				expect(dispatching).toBe(true);
				lifetimes.push(promise);
			},
			respondWith(response: Response | PromiseLike<Response>) {
				responses.push(Promise.resolve(response));
			},
		} satisfies FetchEventPort);
		scope.dispatchEvent(event);
		dispatching = false;
		return { lifetimes, response: responses[0], request };
	}
	return { cache, storage, network, dispatch };
}

function navigationResponse(body: string) {
	const response = new Response(body);
	Object.defineProperty(response, 'type', { value: 'basic' });
	return response;
}

describe('installed service worker fetch handler', () => {
	beforeEach(() => vi.resetModules());
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it('keeps late navigation and its cache write alive after returning the offline fallback', async () => {
		vi.useFakeTimers();
		const { cache, network, dispatch } = harness();
		await installWorker();
		const pendingNetwork = Promise.withResolvers<Response>();
		const pendingWrite = Promise.withResolvers<void>();
		network.mockReturnValue(pendingNetwork.promise);
		cache.put.mockReturnValue(pendingWrite.promise);
		const event = dispatch('/', true);
		expect(event.lifetimes).toHaveLength(1);
		let finished = false;
		void event.lifetimes[0].then(() => {
			finished = true;
		});
		await vi.advanceTimersByTimeAsync(3_000);
		expect(await (await event.response).text()).toBe('offline');
		expect(finished).toBe(false);
		pendingNetwork.resolve(navigationResponse('late'));
		await vi.waitFor(() => expect(cache.put).toHaveBeenCalledOnce());
		expect(finished).toBe(false);
		pendingWrite.resolve();
		await event.lifetimes[0];
		expect(finished).toBe(true);
		expect(await cache.put.mock.calls[0][1].text()).toBe('late');
	});

	it.each([true, false])(
		'returns the response before caching settles (navigation: %s)',
		async (navigate) => {
			const { cache, network, dispatch } = harness();
			await installWorker();
			const pendingWrite = Promise.withResolvers<void>();
			cache.put.mockReturnValue(pendingWrite.promise);
			network.mockResolvedValue(navigationResponse('online'));
			const event = dispatch(navigate ? '/' : '/asset.js', navigate);
			expect(event.lifetimes).toHaveLength(1);
			expect(await (await event.response).text()).toBe('online');
			await vi.waitFor(() => expect(cache.put).toHaveBeenCalledOnce());
			pendingWrite.reject(new Error('Quota exceeded'));
			await expect(event.lifetimes[0]).resolves.toBeUndefined();
		},
	);

	it('ignores failure to open the navigation cache', async () => {
		const { storage, network, dispatch } = harness();
		await installWorker();
		storage.open.mockRejectedValue(new Error('Cache unavailable'));
		network.mockResolvedValue(navigationResponse('online'));
		const event = dispatch('/', true);
		expect(await (await event.response).text()).toBe('online');
		await expect(event.lifetimes[0]).resolves.toBeUndefined();
	});

	it('serves cached assets without another network request or cache write', async () => {
		const { cache, network, dispatch } = harness();
		await installWorker();
		cache.match.mockResolvedValue(new Response('cached'));
		const event = dispatch('/asset.js');
		expect(await (await event.response).text()).toBe('cached');
		await event.lifetimes[0];
		expect(network).not.toHaveBeenCalled();
		expect(cache.put).not.toHaveBeenCalled();
	});

	it.each(['/api/v1/chats', '/ws', '/site.webmanifest'])('does not intercept %s', async (path) => {
		const { dispatch } = harness();
		await installWorker();
		const event = dispatch(path);
		expect(event.response).toBeUndefined();
		expect(event.lifetimes).toEqual([]);
	});
});
