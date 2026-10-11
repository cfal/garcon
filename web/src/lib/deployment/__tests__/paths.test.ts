import { afterEach, expect, it, vi } from 'vitest';
vi.mock('$app/paths', () => ({ base: '/tools/garcon' }));
import { appPath, appPathname } from '../paths';
import { apiFetch, publicApiFetch, setAuthToken } from '$lib/api/client';
import { getAuthStatus, login, register } from '$lib/api/auth';

afterEach(() => {
	vi.unstubAllGlobals();
	localStorage.clear();
});

it('prefixes application URLs and strips only the exact mount', () => {
	expect(appPath('/api/v1/files?path=%2Fa')).toBe('/tools/garcon/api/v1/files?path=%2Fa');
	expect(appPath('/')).toBe('/tools/garcon/');
	expect(appPathname('/tools/garcon/chat/1')).toBe('/chat/1');
	expect(appPathname('/tools/garcon-other/chat/1')).toBe('');
	for (const path of ['https://other.test/api', '//other.test/api', '/\\other.test', 'relative']) {
		expect(() => appPath(path)).toThrow();
	}
});

it('mounts authenticated, public, and authentication requests without leaking credentials', async () => {
	const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({}));
	vi.stubGlobal('fetch', fetcher);
	setAuthToken('synthetic-token');
	const body = new FormData();
	body.set('file', new Blob(['test']), 'synthetic.txt');
	await apiFetch('/api/v1/files', { method: 'POST', body });
	expect(fetcher.mock.calls[0][0]).toBe('/tools/garcon/api/v1/files');
	expect(new Headers(fetcher.mock.calls[0][1]?.headers).get('Authorization')).toBe(
		'Bearer synthetic-token',
	);
	expect(fetcher.mock.calls[0][1]?.body).toBe(body);
	await publicApiFetch('/api/v1/shared?token=synthetic');
	await getAuthStatus();
	await login('synthetic', 'synthetic-password');
	await register('synthetic', 'synthetic-password');
	for (const [url, options] of fetcher.mock.calls.slice(1)) {
		expect(url).toMatch(/^\/tools\/garcon\/api\//);
		expect(new Headers(options?.headers).has('Authorization')).toBe(false);
	}
});
