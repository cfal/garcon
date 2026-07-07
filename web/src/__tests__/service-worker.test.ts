import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchWithTimeout, isManifestPath, precacheAppShell } from '../service-worker-helpers';
import { notificationNavigationPath, parsePushPayload } from '../service-worker-notifications';

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

	it('does not precache the remote title manifest', async () => {
		const addAll = vi.fn<Cache['addAll']>().mockResolvedValue(undefined);
		const add = vi.fn<Cache['add']>().mockResolvedValue(undefined);

		await precacheAppShell(
			{ addAll, add } as unknown as Cache,
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

describe('service worker notification helpers', () => {
	it('parses declarative Web Push payloads', () => {
		const payload = parsePushPayload(
			JSON.stringify({
				web_push: 8030,
				notification: {
					title: 'Garcon',
					body: 'Needs permission',
					navigate: 'https://garcon.test/chat/chat-1',
					tag: 'garcon-chat-chat-1',
					app_badge: '4',
					data: { chatId: 'chat-1' },
				},
			}),
			'https://garcon.test',
		);

		expect(payload?.title).toBe('Garcon');
		expect(payload?.options.body).toBe('Needs permission');
		expect(payload?.options.tag).toBe('garcon-chat-chat-1');
		expect(payload?.options.data).toEqual({ chatId: 'chat-1', url: '/chat/chat-1' });
		expect(payload?.badgeCount).toBe(4);
	});

	it('rejects invalid or cross-origin push navigation', () => {
		expect(parsePushPayload('{', 'https://garcon.test')).toBeNull();
		expect(
			parsePushPayload(
				JSON.stringify({
					notification: {
						title: 'Garcon',
						navigate: 'https://evil.example/chat/chat-1',
					},
				}),
				'https://garcon.test',
			),
		).toBeNull();
	});

	it('extracts same-origin notification click paths', () => {
		expect(
			notificationNavigationPath(
				{ url: 'https://garcon.test/chat/chat-1?x=1#bottom' },
				'https://garcon.test',
			),
		).toBe('/chat/chat-1?x=1#bottom');
		expect(
			notificationNavigationPath({ url: 'https://evil.example/chat/chat-1' }, 'https://garcon.test'),
		).toBeNull();
	});
});
