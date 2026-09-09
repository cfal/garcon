import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	createCanvas,
	deleteCanvas,
	getCanvas,
	listCanvases,
	updateCanvas,
} from '../chat-canvases';
import { ApiError } from '../client';

afterEach(() => vi.unstubAllGlobals());
const canvas = {
	version: 1,
	id: 'board',
	revision: 1,
	updatedAt: '2026-09-07T00:00:00Z',
	content: { title: 'Work', nodes: [], connections: [] },
};

describe('canvas HTTP contract', () => {
	it('sends typed content and revisions and normalizes both response paths', async () => {
		const fetch = vi.fn().mockImplementation(() => Promise.resolve(Response.json(canvas)));
		vi.stubGlobal('fetch', fetch);
		expect(await getCanvas('board')).toEqual(canvas);
		expect(fetch.mock.calls[0][0]).toBe('/api/v1/chat-canvases?id=board');
		await createCanvas({ id: canvas.id, content: canvas.content });
		await updateCanvas({ id: canvas.id, expectedRevision: 1, content: canvas.content });
		expect(JSON.parse(fetch.mock.calls[2][1].body)).toEqual({
			id: 'board',
			expectedRevision: 1,
			content: canvas.content,
		});
		fetch.mockResolvedValueOnce(Response.json({ canvases: [], unavailableIds: ['damaged'] }));
		expect(await listCanvases()).toEqual({ canvases: [], unavailableIds: ['damaged'] });
		fetch.mockResolvedValueOnce(Response.json({ success: true }));
		await deleteCanvas({ id: 'board', expectedRevision: 1 });
		expect(fetch.mock.calls[4][1].method).toBe('DELETE');
	});

	it('rejects malformed responses and preserves conflict status', async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(Response.json({ ...canvas, revision: -1 }))
			.mockResolvedValueOnce(
				Response.json(
					{ error: 'Changed elsewhere', errorCode: 'CANVAS_CONFLICT' },
					{ status: 409 },
				),
			);
		vi.stubGlobal('fetch', fetch);
		await expect(getCanvas('board')).rejects.toThrow('Invalid canvas');
		await expect(
			updateCanvas({ id: 'board', expectedRevision: 1, content: canvas.content }),
		).rejects.toMatchObject({ status: 409, errorCode: 'CANVAS_CONFLICT', constructor: ApiError });
	});
});
