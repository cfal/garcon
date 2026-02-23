import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { apiGet, apiPost, apiPut, apiDelete, apiPostForm, ApiError, getAuthToken, setAuthToken, clearAuthToken } from '../client';

// Stub localStorage for token management.
const store: Record<string, string> = {};
vi.stubGlobal('localStorage', {
	getItem: (k: string) => store[k] ?? null,
	setItem: (k: string, v: string) => { store[k] = v; },
	removeItem: (k: string) => { delete store[k]; },
});

describe('token management', () => {
	afterEach(() => {
		for (const k of Object.keys(store)) delete store[k];
	});

	it('getAuthToken returns null when no token set', () => {
		expect(getAuthToken()).toBeNull();
	});

	it('setAuthToken persists and getAuthToken retrieves', () => {
		setAuthToken('tok-123');
		expect(getAuthToken()).toBe('tok-123');
	});

	it('clearAuthToken removes the token', () => {
		setAuthToken('tok-123');
		clearAuthToken();
		expect(getAuthToken()).toBeNull();
	});
});

describe('API client helpers', () => {
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		for (const k of Object.keys(store)) delete store[k];
		setAuthToken('test-token');
		fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	function jsonResponse(body: unknown, status = 200) {
		return new Response(JSON.stringify(body), {
			status,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	it('apiGet sends GET with auth header and parses JSON', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ items: [1, 2] }));

		const result = await apiGet<{ items: number[] }>('/api/test');

		expect(result).toEqual({ items: [1, 2] });
		const [url, opts] = fetchMock.mock.calls[0];
		expect(url).toBe('/api/test');
		expect(opts.headers['Authorization']).toBe('Bearer test-token');
		expect(opts.headers['Content-Type']).toBe('application/json');
	});

	it('apiPost sends POST with JSON body', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

		await apiPost('/api/create', { name: 'test' });

		const [, opts] = fetchMock.mock.calls[0];
		expect(opts.method).toBe('POST');
		expect(JSON.parse(opts.body)).toEqual({ name: 'test' });
	});

	it('apiPut sends PUT with JSON body', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

		await apiPut('/api/update', { name: 'updated' });

		const [, opts] = fetchMock.mock.calls[0];
		expect(opts.method).toBe('PUT');
	});

	it('apiDelete sends DELETE', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

		await apiDelete('/api/remove');

		const [, opts] = fetchMock.mock.calls[0];
		expect(opts.method).toBe('DELETE');
	});

	it('apiPostForm sends FormData without Content-Type', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ uploaded: true }));

		const formData = new FormData();
		formData.append('file', 'data');
		await apiPostForm('/api/upload', formData);

		const [, opts] = fetchMock.mock.calls[0];
		expect(opts.method).toBe('POST');
		expect(opts.body).toBeInstanceOf(FormData);
		// FormData requests should NOT have Content-Type set
		// (browser sets it with boundary automatically)
		expect(opts.headers['Content-Type']).toBeUndefined();
	});

	it('throws ApiError on non-ok response with error body', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ error: 'Not found' }, 404));

		try {
			await apiGet('/api/missing');
			expect.unreachable('should have thrown');
		} catch (err) {
			expect(err).toBeInstanceOf(ApiError);
			expect((err as ApiError).status).toBe(404);
			expect((err as ApiError).message).toBe('Not found');
		}
	});

	it('throws ApiError with statusText when body has no error field', async () => {
		fetchMock.mockResolvedValue(
			new Response('not json', { status: 500, statusText: 'Internal Server Error' })
		);

		await expect(apiGet('/api/broken')).rejects.toThrow('Internal Server Error');
	});

	it('includes timeout signal in requests', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

		await apiGet('/api/test');

		const [, opts] = fetchMock.mock.calls[0];
		expect(opts.signal).toBeDefined();
	});

	it('omits auth header when no token is set', async () => {
		clearAuthToken();
		fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

		await apiGet('/api/test');

		const [, opts] = fetchMock.mock.calls[0];
		expect(opts.headers['Authorization']).toBeUndefined();
	});
});
