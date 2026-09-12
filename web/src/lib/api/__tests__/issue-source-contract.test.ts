import { afterEach, expect, it, vi } from 'vitest';
import { resolveIssueSource } from '../issue-source.js';
import { getChatMessages } from '../chats.js';
import { ApiError } from '../client.js';

const source = {
	chatId: '1000000000000001',
	transcriptViewId: '11111111-1111-4111-8111-111111111111',
	ordinal: 7,
};
afterEach(() => vi.unstubAllGlobals());

it('sends a no-store view-qualified source address only on demand', async () => {
	const fetcher = vi.fn<typeof fetch>(async () =>
		Response.json({ kind: 'found', target: { ...source, ordinal: 11 } }),
	);
	vi.stubGlobal('fetch', fetcher);
	const abort = new AbortController();
	expect(await resolveIssueSource(source, abort.signal)).toEqual({
		kind: 'found',
		target: { ...source, ordinal: 11 },
	});
	const [url, options] = fetcher.mock.calls[0]!;
	expect(new URL(String(url), 'http://localhost').searchParams.get('ordinal')).toBe('7');
	expect(new URL(String(url), 'http://localhost').searchParams.get('transcriptViewId')).toBe(
		source.transcriptViewId,
	);
	expect(options?.cache).toBe('no-store');
	abort.abort();
	expect(options?.signal?.aborted).toBe(true);
});

it.each([
	{ ...source, chatId: '1000000000000002' },
	{ ...source, transcriptViewId: '22222222-2222-4222-8222-222222222222' },
])('rejects mismatched source resolutions', async (target) => {
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => Response.json({ kind: 'found', target })),
	);
	await expect(resolveIssueSource(source, new AbortController().signal)).rejects.toThrow(
		'does not match',
	);
});

it('retains typed source failures and propagates target-page cancellation to HTTP', async () => {
	const fetcher = vi.fn<typeof fetch>(async () =>
		Response.json(
			{
				success: false,
				error: 'Synthetic missing chat',
				errorCode: 'SESSION_NOT_FOUND',
				retryable: false,
			},
			{ status: 404 },
		),
	);
	vi.stubGlobal('fetch', fetcher);
	await expect(resolveIssueSource(source, new AbortController().signal)).rejects.toBeInstanceOf(
		ApiError,
	);
	const abort = new AbortController();
	await expect(
		getChatMessages(
			{
				chatId: source.chatId,
				transcriptViewId: source.transcriptViewId,
				beforeOrdinal: 12,
				limit: 50,
			},
			{ signal: abort.signal },
		),
	).rejects.toBeInstanceOf(ApiError);
	abort.abort();
	expect(fetcher.mock.calls[1]?.[1]?.signal?.aborted).toBe(true);
});
