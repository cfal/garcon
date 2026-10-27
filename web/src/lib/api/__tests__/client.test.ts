import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	apiGet,
	apiPost,
	apiPut,
	apiPatch,
	apiDelete,
	apiPostForm,
	ApiError,
	isIntermediaryResponse,
	publicApiFetch,
	getAuthToken,
	setAuthToken,
	clearAuthToken,
} from '../client';

const store: Record<string, string> = {};
beforeEach(() => {
	for (const key of Object.keys(store)) delete store[key];
	vi.stubGlobal('localStorage', {
		getItem: (key: string) => store[key] ?? null,
		setItem: (key: string, value: string) => {
			store[key] = value;
		},
		removeItem: (key: string) => {
			delete store[key];
		},
	});
	clearAuthToken();
});
afterEach(() => {
	clearAuthToken();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe('token management', () => {
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
		setAuthToken('test-token');
		fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
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
		expect(opts.headers.get('Authorization')).toBe('Bearer test-token');
		expect(opts.headers.get('Content-Type')).toBe('application/json');
	});

	describe.each([
		['POST', apiPost],
		['PUT', apiPut],
		['PATCH', apiPatch],
		['DELETE', apiDelete],
	] as const)('%s requests', (method, send) => {
		it.each([{ name: 'synthetic' }, null, false, undefined])(
			'preserves the JSON body %j and parses its response',
			async (body) => {
				fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
				expect(await send('/api/mutate', body)).toEqual({ ok: true });
				const [url, options] = fetchMock.mock.calls[0];
				expect(url).toBe('/api/mutate');
				expect(options.method).toBe(method);
				expect(options.body).toBe(body === undefined ? undefined : JSON.stringify(body));
				expect(options.headers.get('Authorization')).toBe('Bearer test-token');
			},
		);
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
		expect(opts.headers.has('Content-Type')).toBe(false);
	});

	it('apiPostForm preserves caller headers', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ uploaded: true }));

		const formData = new FormData();
		await apiPostForm('/api/upload', formData, { headers: { 'X-Upload-Token': 'token-1' } });

		const [, opts] = fetchMock.mock.calls[0];
		expect(opts.headers.get('X-Upload-Token')).toBe('token-1');
		expect(opts.headers.has('Content-Type')).toBe(false);
	});

	it.each<{ headers: HeadersInit }>([
		{ headers: { authorization: 'Custom token', 'content-type': 'text/plain', 'X-Test': 'kept' } },
		{
			headers: new Headers({
				authorization: 'Custom token',
				'content-type': 'text/plain',
				'X-Test': 'kept',
			}),
		},
		{
			headers: [
				['authorization', 'Custom token'],
				['content-type', 'text/plain'],
				['X-Test', 'kept'],
			],
		},
	])('preserves caller overrides in every HeadersInit form: %j', async ({ headers }) => {
		fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
		await apiGet('/api/test', { headers });
		const actual = new Headers(fetchMock.mock.calls[0][1].headers);
		expect(actual.get('Authorization')).toBe('Custom token');
		expect(actual.get('Content-Type')).toBe('text/plain');
		expect(actual.get('X-Test')).toBe('kept');
		expect([...actual]).toHaveLength(3);
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

	it('preserves errorCode and details from error payload', async () => {
		fetchMock.mockResolvedValue(
			jsonResponse(
				{
					success: false,
					error: 'Timed out',
					errorCode: 'commit_message_timeout',
					retryable: true,
					details: 'upstream timeout',
					queue: { version: 7 },
				},
				504,
			),
		);

		try {
			await apiGet('/api/git/generate-commit-message');
			expect.unreachable('should have thrown');
		} catch (err) {
			expect(err).toBeInstanceOf(ApiError);
			const apiErr = err as ApiError;
			expect(apiErr.status).toBe(504);
			expect(apiErr.errorCode).toBe('commit_message_timeout');
			expect(apiErr.details).toBe('upstream timeout');
			expect(apiErr.retryable).toBe(true);
			expect(apiErr.payload).toMatchObject({ queue: { version: 7 } });
		}
	});

	it.each([true, false])(
		'distinguishes a coded share failure from an intermediary: %s',
		async (coded) => {
			fetchMock.mockResolvedValue(
				jsonResponse(
					{
						success: false,
						error: 'Internal server error',
						...(coded ? { errorCode: 'INTERNAL_ERROR', retryable: true } : {}),
					},
					500,
				),
			);
			try {
				await apiPost('/api/v1/chats/share', { chatId: '123' });
				expect.unreachable('should have thrown');
			} catch (error) {
				expect(error).toBeInstanceOf(ApiError);
				expect(isIntermediaryResponse(error as ApiError)).toBe(!coded);
				expect((error as ApiError).message).toBe('Internal server error');
			}
		},
	);

	it('keeps legacy error bodies working without using message fallback', async () => {
		fetchMock.mockResolvedValue(
			jsonResponse(
				{
					error: 'Legacy route error',
					errorCode: 'legacy_error',
					message: 'Do not use this field',
				},
				400,
			),
		);

		await expect(apiGet('/api/legacy')).rejects.toMatchObject({
			status: 400,
			message: 'Legacy route error',
			errorCode: 'legacy_error',
			retryable: false,
		});
	});

	it('falls back to statusText for message-only error bodies', async () => {
		fetchMock.mockResolvedValue(
			new Response(JSON.stringify({ message: 'Legacy message only' }), {
				status: 400,
				statusText: 'Bad Request',
			}),
		);

		await expect(apiGet('/api/message-only')).rejects.toMatchObject({
			status: 400,
			message: 'Bad Request',
		});
	});

	it('throws ApiError with statusText when body has no error field', async () => {
		fetchMock.mockResolvedValue(
			new Response('not json', { status: 500, statusText: 'Internal Server Error' }),
		);

		await expect(apiGet('/api/broken')).rejects.toThrow('Internal Server Error');
	});

	it('includes timeout signal in requests', async () => {
		const timeout = vi.spyOn(AbortSignal, 'timeout');
		fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

		await apiGet('/api/test');

		const [, opts] = fetchMock.mock.calls[0];
		expect(opts.signal).toBeDefined();
		expect(timeout).toHaveBeenCalledWith(30_000);
	});

	describe.each([
		['authenticated', apiGet],
		['public', publicApiFetch],
	] as const)('%s request cancellation', (_, send) => {
		it.each(['caller', 'deadline', 'already aborted'] as const)(
			'rejects on %s without retrying or aborting the other signal',
			async (source) => {
				const caller = new AbortController();
				const deadline = new AbortController();
				const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
				const reason = new DOMException(
					'Synthetic cancellation',
					source === 'deadline' ? 'TimeoutError' : 'AbortError',
				);
				fetchMock.mockImplementation(
					(_url: string, options: RequestInit) =>
						new Promise<Response>((_resolve, reject) => {
							const signal = options.signal!;
							if (signal.aborted) reject(signal.reason);
							else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
						}),
				);
				if (source === 'already aborted') caller.abort(reason);
				const pending = send('/api/wait', { signal: caller.signal, timeoutMs: 5000 }).catch(
					(error) => error,
				);
				try {
					(source === 'deadline' ? deadline : caller).abort(reason);
					const signal = fetchMock.mock.calls[0][1].signal;
					expect(signal.aborted).toBe(true);
					expect(signal.reason).toBe(reason);
					expect(await pending).toBe(reason);
					expect(timeout).toHaveBeenCalledWith(5000);
					expect(fetchMock).toHaveBeenCalledTimes(1);
					expect((source === 'deadline' ? caller : deadline).signal.aborted).toBe(false);
				} finally {
					caller.abort();
					deadline.abort();
					await pending;
				}
			},
		);
	});

	it('uses the standard timeout without credentials for public requests', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

		await publicApiFetch('/api/public');

		const [, opts] = fetchMock.mock.calls[0];
		expect(opts.signal).toBeDefined();
		expect(opts.headers).toBeUndefined();
	});

	it('allows callers to disable the default timeout while preserving their signal', async () => {
		const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
		const controller = new AbortController();
		fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

		await apiGet('/api/long-request', { timeoutMs: null, signal: controller.signal });

		const [, opts] = fetchMock.mock.calls[0];
		expect(timeoutSpy).not.toHaveBeenCalled();
		expect(opts.signal).toBe(controller.signal);
	});

	it('omits auth header when no token is set', async () => {
		clearAuthToken();
		fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

		await apiGet('/api/test');

		const [, opts] = fetchMock.mock.calls[0];
		expect(opts.headers.has('Authorization')).toBe(false);
	});

	it('accepts timeout options for PUT, DELETE, and form POST helpers', async () => {
		const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
		fetchMock
			.mockResolvedValueOnce(jsonResponse({ ok: true }))
			.mockResolvedValueOnce(jsonResponse({ ok: true }))
			.mockResolvedValueOnce(jsonResponse({ ok: true }));

		await apiPut('/api/update', { name: 'updated' }, { timeoutMs: 5_000 });
		await apiDelete('/api/remove', undefined, { timeoutMs: 6_000 });
		const formData = new FormData();
		await apiPostForm('/api/upload', formData, { timeoutMs: 7_000 });

		expect(timeoutSpy).toHaveBeenNthCalledWith(1, 5_000);
		expect(timeoutSpy).toHaveBeenNthCalledWith(2, 6_000);
		expect(timeoutSpy).toHaveBeenNthCalledWith(3, 7_000);
	});
});
