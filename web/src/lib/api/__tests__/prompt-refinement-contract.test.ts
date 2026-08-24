import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../client';
import { PROMPT_REFINEMENT_CLIENT_TIMEOUT_MS, refinePrompt } from '../prompt-refinement';

vi.stubGlobal('localStorage', {
	getItem: () => 'test-token',
	setItem: () => {},
	removeItem: () => {},
});

describe('prompt refinement API contract', () => {
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
	});

	afterEach(() => vi.restoreAllMocks());

	it('posts the discriminated target with a caller-cancellable two-minute request', async () => {
		fetchMock.mockResolvedValueOnce(
			Response.json({ success: true, refinedPrompt: '  Refined request.  ' }),
		);
		const controller = new AbortController();

		await expect(
			refinePrompt({ draft: 'rough request', target: 'prompt' }, { signal: controller.signal }),
		).resolves.toEqual({ success: true, refinedPrompt: 'Refined request.' });
		expect(PROMPT_REFINEMENT_CLIENT_TIMEOUT_MS).toBe(120_000);

		const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe('/api/v1/prompts/refine');
		expect(options.method).toBe('POST');
		expect(JSON.parse(options.body as string)).toEqual({
			draft: 'rough request',
			target: 'prompt',
		});
		expect(options.signal).toBeInstanceOf(AbortSignal);
		controller.abort();
		expect((options.signal as AbortSignal).aborted).toBe(true);
	});

	it('rejects malformed success responses at the client boundary', async () => {
		fetchMock.mockResolvedValueOnce(Response.json({ success: true, refinedPrompt: ' ' }));

		await expect(refinePrompt({ draft: 'rough request', target: 'prompt' })).rejects.toMatchObject({
			status: 502,
			errorCode: 'PROMPT_REFINEMENT_INVALID_RESPONSE',
		});
	});

	it('preserves structured server errors', async () => {
		fetchMock.mockResolvedValueOnce(
			Response.json(
				{
					success: false,
					error: 'Prompt refinement timed out.',
					errorCode: 'PROMPT_REFINEMENT_TIMEOUT',
					retryable: true,
				},
				{ status: 504 },
			),
		);

		try {
			await refinePrompt({ draft: 'rough request', target: 'prompt' });
			throw new Error('Expected request to fail');
		} catch (error) {
			expect(error).toBeInstanceOf(ApiError);
			expect(error).toMatchObject({
				status: 504,
				errorCode: 'PROMPT_REFINEMENT_TIMEOUT',
				retryable: true,
			});
		}
	});

	it('rechecks snippet token signatures at the client boundary', async () => {
		fetchMock.mockResolvedValueOnce(
			Response.json({ success: true, refinedPrompt: 'Review without the variable.' }),
		);

		await expect(
			refinePrompt({ draft: 'Review {{arguments}}.', target: 'snippet-template' }),
		).rejects.toMatchObject({
			status: 502,
			errorCode: 'PROMPT_REFINEMENT_TOKEN_SIGNATURE_CHANGED',
		});
	});
});
