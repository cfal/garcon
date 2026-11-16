import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setChatParent } from '../chats.js';
import { ApiError, ApiMutationOutcomeUnknownError } from '../client.js';

const chatId = '1783725900000200';
const parentChatId = '1783725900000201';
const reply = {
	success: true,
	chatId,
	parentChat: { chatId: parentChatId, relation: 'delegation' },
	changed: true,
};
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
	vi.stubGlobal('localStorage', {
		getItem: (key: string) =>
			key === 'bearer-token' ? JSON.stringify({ token: 'test-token', epoch: null }) : null,
		setItem() {},
		removeItem() {},
	});
	fetchMock = vi.fn();
	vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('parent mutation API', () => {
	it('makes one correlated PUT without an optimistic full-chat response', async () => {
		fetchMock.mockResolvedValue(Response.json(reply));
		expect(await setChatParent({ chatId, parentChatId })).toEqual(reply);
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(fetchMock).toHaveBeenCalledWith(
			'/api/v1/chats/parent',
			expect.objectContaining({ method: 'PUT', body: JSON.stringify({ chatId, parentChatId }) }),
		);
	});
	it.each([
		() => Response.json({ ...reply, chatId: parentChatId }),
		() => Response.json({ ...reply, parentChat: null }),
		() => new Response('{'),
		() => new Response('Gateway failure', { status: 502 }),
		() =>
			Response.json(
				{
					success: false,
					error: 'Unknown',
					errorCode: 'CHAT_PARENT_SAVE_UNKNOWN',
					retryable: false,
				},
				{ status: 503 },
			),
	])('reports uncertain replies without retry', async (response) => {
		fetchMock.mockResolvedValue(response());
		await expect(setChatParent({ chatId, parentChatId })).rejects.toBeInstanceOf(
			ApiMutationOutcomeUnknownError,
		);
		expect(fetchMock).toHaveBeenCalledOnce();
	});
	it('preserves a definite save failure', async () => {
		fetchMock.mockResolvedValue(
			Response.json(
				{ success: false, error: 'Failed', errorCode: 'CHAT_PARENT_SAVE_FAILED', retryable: true },
				{ status: 503 },
			),
		);
		await expect(setChatParent({ chatId, parentChatId })).rejects.toBeInstanceOf(ApiError);
	});
});
