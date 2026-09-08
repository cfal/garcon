import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { replaceChatTags } from '../chats.js';
import { ApiError, ApiMutationOutcomeUnknownError } from '../client.js';

describe('chat tag API contract', () => {
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.stubGlobal('localStorage', {
			getItem: () => 'test-token',
			setItem: () => {},
			removeItem: () => {},
		});
		fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	function replace() {
		return replaceChatTags({
			chatId: 'chat-1',
			expectedTags: ['ready'],
			tags: ['review'],
		});
	}

	it.each([
		{
			name: 'an untyped gateway failure',
			response: () => new Response('Gateway Timeout', { status: 504, statusText: 'Gateway Timeout' }),
		},
		{
			name: 'malformed successful JSON',
			response: () => new Response('{', { status: 200, headers: { 'Content-Type': 'application/json' } }),
		},
		{
			name: 'an invalid successful envelope',
			response: () => Response.json({ success: true }),
		},
	])('marks $name as an unknown mutation outcome', async ({ response }) => {
		fetchMock.mockResolvedValue(response());

		await expect(replace()).rejects.toBeInstanceOf(ApiMutationOutcomeUnknownError);
	});

	it('preserves a definitive typed rejection', async () => {
		fetchMock.mockResolvedValue(Response.json({
			success: false,
			error: 'Tags could not be saved',
			errorCode: 'CHAT_TAG_SAVE_FAILED',
			retryable: true,
		}, { status: 503 }));


		try {
			await replace();
			expect.unreachable('Expected a typed rejection');
		} catch (error) {
			expect(error).toBeInstanceOf(ApiError);
			expect(error).not.toBeInstanceOf(ApiMutationOutcomeUnknownError);
		}
	});
});
