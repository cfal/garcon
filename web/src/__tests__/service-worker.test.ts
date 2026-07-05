import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchWithTimeout, precacheAppShell } from '../service-worker-helpers';

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
				{ addAll, add } as unknown as Cache,
				{ build: ['/build/app.js'], files: ['/favicon.png', '/missing-static-file.png'] },
			),
		).resolves.toBeUndefined();

		expect(addAll).toHaveBeenCalledWith(['/', '/build/app.js']);
		expect(add).toHaveBeenCalledWith('/favicon.png');
		expect(add).toHaveBeenCalledWith('/missing-static-file.png');
	});

	it('times out navigation fetches while preserving the late response hook', async () => {
		vi.useFakeTimers();
		let resolveFetch!: (response: Response) => void;
		const fetchImpl = vi.fn<typeof fetch>(
			() =>
				new Promise<Response>((resolve) => {
					resolveFetch = resolve;
				}),
		);
		const onResponse = vi.fn();
		const request = new Request('https://garcon.test/');

		const navigation = fetchWithTimeout(request, {
			timeoutMs: 100,
			fetchImpl,
			onResponse,
		});
		const timeoutExpectation = expect(navigation).rejects.toThrow('navigation timeout');

		await vi.advanceTimersByTimeAsync(100);
		await timeoutExpectation;

		const lateResponse = new Response('late');
		resolveFetch(lateResponse);
		await Promise.resolve();

		expect(onResponse).toHaveBeenCalledWith(lateResponse);
	});
});
