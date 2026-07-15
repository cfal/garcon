import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSnippet, expandSnippet, getSnippets } from '../snippets';

vi.stubGlobal('localStorage', {
	getItem: () => 'test-token',
	setItem: () => {},
	removeItem: () => {},
});

const snippet = {
	id: 'snippet-review',
	shortName: 'review',
	template: 'Review {{arguments}} in {{project_path}}',
	createdAt: '2029-01-01T00:00:00.000Z',
	updatedAt: '2029-01-01T00:00:00.000Z',
};

describe('snippets API contract', () => {
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('normalizes snapshots and sends typed create requests', async () => {
		fetchMock.mockResolvedValueOnce(Response.json({ revision: 1, snippets: [snippet] }));
		await expect(getSnippets()).resolves.toEqual({ revision: 1, snippets: [snippet] });

		fetchMock.mockResolvedValueOnce(
			Response.json({ success: true, snapshot: { revision: 2, snippets: [snippet] } }),
		);
		await createSnippet({
			expectedRevision: 1,
			snippet: { shortName: 'review', template: snippet.template },
		});

		const [url, options] = fetchMock.mock.calls[1];
		expect(url).toBe('/api/v1/snippets');
		expect(options.method).toBe('POST');
		expect(JSON.parse(options.body)).toEqual({
			expectedRevision: 1,
			snippet: { shortName: 'review', template: snippet.template },
		});
	});

	it('rejects malformed snapshots and expansion responses', async () => {
		fetchMock.mockResolvedValueOnce(
			Response.json({ revision: 1, snippets: [{ ...snippet, shortName: 'Review' }] }),
		);
		await expect(getSnippets()).rejects.toThrow('Invalid snippets response');

		fetchMock.mockResolvedValueOnce(
			Response.json({
				success: true,
				snippetId: snippet.id,
				shortName: snippet.shortName,
				expandedText: 42,
			}),
		);
		await expect(
			expandSnippet({
				shortName: 'review',
				arguments: 'the API',
				context: { type: 'project', projectPath: '/repo' },
			}),
		).rejects.toThrow('Invalid snippet expansion response');
	});

	it('passes an abort signal to expansion requests', async () => {
		let release!: (response: Response) => void;
		fetchMock.mockImplementation(() => new Promise<Response>((resolve) => (release = resolve)));
		const controller = new AbortController();
		const expanding = expandSnippet(
			{
				shortName: 'review',
				arguments: 'the API',
				context: { type: 'project', projectPath: '/repo' },
			},
			{ signal: controller.signal },
		);
		const requestSignal = fetchMock.mock.calls[0][1].signal as AbortSignal;
		expect(requestSignal.aborted).toBe(false);
		controller.abort();
		expect(requestSignal.aborted).toBe(true);
		release(
			Response.json({
				success: true,
				snippetId: snippet.id,
				shortName: snippet.shortName,
				expandedText: 'Review the API in /repo',
			}),
		);
		await expanding;
	});
});
