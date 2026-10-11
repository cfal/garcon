import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearChat } from '../chat-clear.js';
import { ApiError, ApiMutationOutcomeUnknownError } from '../client.js';

const request = { chatId: '1780000000000001', transcriptViewId: 'view-1', lastOrdinal: 3, target: { kind: 'all' as const } };
const response = { success: true, chatId: request.chatId, transcriptViewId: 'view-2' };
const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => vi.unstubAllGlobals());

it('sends the pinned target exactly once and validates its replacement', async () => {
	fetchMock.mockResolvedValue(Response.json(response));
	await expect(clearChat(request)).resolves.toEqual(response);
	expect(fetchMock).toHaveBeenCalledExactlyOnceWith('/api/v1/chats/clear', expect.objectContaining({
		method: 'POST', body: JSON.stringify(request),
	}));
});

it.each([
	() => Response.json({ ...response, success: false }),
	() => Response.json({ ...response, chatId: '1780000000000002' }),
	() => Response.json({ ...response, transcriptViewId: 'view-1' }),
	() => Response.json({ ...response, transcriptViewId: '' }),
	() => new Response('{', { status: 200 }),
	() => new Response('{', { status: 409 }),
	() => Response.json({ error: 'Rejected', errorCode: 'STALE_TRANSCRIPT_VIEW' }, { status: 409 }),
	() => Response.json({ success: false, error: 'Rejected', errorCode: 'STALE_TRANSCRIPT_VIEW', retryable: 'false' }, { status: 409 }),
	() => new Response('Forbidden', { status: 403 }),
	() => new Response('timeout', { status: 504 }),
	() => Response.json({ success: false, error: 'Unknown', errorCode: 'TRANSCRIPT_CLEAR_OUTCOME_UNKNOWN', retryable: false }, { status: 503 }),
	() => Response.json({ success: false, error: 'Unknown', errorCode: 'INTERNAL_ERROR', retryable: true }, { status: 500 }),
])('treats invalid or ambiguous responses as unknown without retrying: %#', async reply => {
	fetchMock.mockResolvedValue(reply());
	await expect(clearChat(request)).rejects.toBeInstanceOf(ApiMutationOutcomeUnknownError);
	expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('treats a lost acknowledgement as unknown without retrying', async () => {
	fetchMock.mockRejectedValue(new TypeError('Connection lost'));
	await expect(clearChat(request)).rejects.toBeInstanceOf(ApiMutationOutcomeUnknownError);
	expect(fetchMock).toHaveBeenCalledTimes(1);
});

it.each(['CHAT_RUNNING', 'STALE_TRANSCRIPT_VIEW', 'OWNERSHIP_TRANSFER_PENDING'])('preserves definite %s rejection', async errorCode => {
	fetchMock.mockResolvedValue(Response.json({ success: false, error: 'Rejected', errorCode, retryable: false }, { status: 409 }));
	await expect(clearChat(request)).rejects.toBeInstanceOf(ApiError);
});
