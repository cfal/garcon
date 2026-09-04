import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	createPreamble,
	getPreambles,
	removePreamble,
	reorderPreambles,
	updatePreamble,
} from '../preambles';

vi.stubGlobal('localStorage', {
	getItem: () => 'test-token',
	setItem: () => {},
	removeItem: () => {},
});

const preamble = {
	id: 'preamble-a',
	enabled: true,
	title: 'Repository conventions',
	content: 'Use the repository conventions.',
	scope: { type: 'global' as const },
	createdAt: '2029-01-01T00:00:00.000Z',
	updatedAt: '2029-01-01T00:00:00.000Z',
};

describe('preambles API contract', () => {
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('normalizes snapshots and sends typed catalog mutations', async () => {
		fetchMock
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ revision: 1, preambles: [preamble] }),
			})
			.mockResolvedValue({
				ok: true,
				json: async () => ({
					success: true,
					snapshot: { revision: 2, preambles: [preamble] },
				}),
			});

		await expect(getPreambles()).resolves.toEqual({ revision: 1, preambles: [preamble] });
		const definition = {
			enabled: true,
			title: 'Repository conventions',
			content: 'Use the repository conventions.',
			scope: { type: 'global' as const },
		};
		await createPreamble({ expectedRevision: 1, preamble: definition });
		await updatePreamble({ expectedRevision: 1, id: 'preamble-a', preamble: definition });
		await removePreamble({ expectedRevision: 1, id: 'preamble-a' });
		await reorderPreambles({ expectedRevision: 1, orderedPreambleIds: ['preamble-a'] });

		expect(fetchMock.mock.calls.map(([url, options]) => [url, options?.method])).toEqual([
			['/api/v1/preambles', undefined],
			['/api/v1/preambles', 'POST'],
			['/api/v1/preambles', 'PUT'],
			['/api/v1/preambles', 'DELETE'],
			['/api/v1/preambles/reorder', 'PUT'],
		]);
		expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
			expectedRevision: 1,
			preamble: definition,
		});
	});

	it('rejects malformed catalog responses', async () => {
		fetchMock.mockResolvedValueOnce(Response.json({ revision: 1, preambles: [{ ...preamble, id: '' }] }));
		await expect(getPreambles()).rejects.toThrow('Invalid preambles response');

		fetchMock.mockResolvedValueOnce(Response.json({ success: true, snapshot: { revision: -1 } }));
		await expect(removePreamble({ expectedRevision: 1, id: 'preamble-a' })).rejects.toThrow(
			'Invalid preamble mutation response',
		);
	});
});
