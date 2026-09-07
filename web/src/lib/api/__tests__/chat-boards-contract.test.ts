import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chatBoardApi } from '../chat-boards';

vi.stubGlobal('localStorage', {
	getItem: () => 'test-token',
	setItem: () => {},
	removeItem: () => {},
});

const BOARD_ID = '11111111-1111-4111-8111-111111111111';
const COLUMN_ID = '22222222-2222-4222-8222-222222222222';
const board = {
	id: BOARD_ID,
	name: 'Delivery',
	columns: [{ id: COLUMN_ID, name: 'Ready', match: 'all' as const, tags: ['ready'] }],
};

describe('Chat Board API contract', () => {
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
	});

	afterEach(() => vi.restoreAllMocks());

	it('decodes catalogs and sends typed ordered mutations', async () => {
		fetchMock
			.mockResolvedValueOnce(Response.json({ revision: 1, boards: [board] }))
			.mockResolvedValueOnce(Response.json({
				success: true,
				boardId: BOARD_ID,
				catalog: { revision: 2, boards: [board] },
			}))
			.mockImplementation(() => Promise.resolve(Response.json({
				success: true,
				catalog: { revision: 3, boards: [board] },
			})));

		await expect(chatBoardApi.load()).resolves.toEqual({ revision: 1, boards: [board] });
		await chatBoardApi.create(1, 'Delivery');
		await chatBoardApi.update(2, board);
		await chatBoardApi.remove(2, BOARD_ID);
		await chatBoardApi.reorder(2, [BOARD_ID]);

		expect(fetchMock.mock.calls.map(([url, options]) => [url, options?.method])).toEqual([
			['/api/v1/chat-boards', undefined],
			['/api/v1/chat-boards', 'POST'],
			['/api/v1/chat-boards', 'PUT'],
			['/api/v1/chat-boards', 'DELETE'],
			['/api/v1/chat-boards/order', 'PUT'],
		]);
		expect(JSON.parse(fetchMock.mock.calls[2]![1]!.body)).toEqual({
			expectedRevision: 2,
			board,
		});
	});

	it('rejects malformed catalogs and mutation envelopes', async () => {
		fetchMock.mockResolvedValueOnce(Response.json({ revision: -1, boards: [] }));
		await expect(chatBoardApi.load()).rejects.toThrow('Invalid chat board catalog response');

		fetchMock.mockResolvedValueOnce(Response.json({
			success: true,
			catalog: { revision: 2, boards: [] },
			extra: true,
		}));
		await expect(chatBoardApi.remove(1, BOARD_ID)).rejects.toThrow(
			'Invalid chat board mutation response',
		);
	});
});
