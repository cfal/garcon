import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getTree, getFileList, readText, saveText, validateDir, browseDirectory } from '../files';

vi.stubGlobal('localStorage', {
	getItem: () => 'test-token',
	setItem: () => {},
	removeItem: () => {},
});

describe('files API contract', () => {
	let fetchMock: ReturnType<typeof vi.fn>;

	function jsonResponse(body: unknown, status = 200) {
		return new Response(JSON.stringify(body), {
			status,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	beforeEach(() => {
		fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('getTree calls GET /api/v1/files/tree with chatId query', async () => {
		const payload = [{ name: 'src', path: '/src', type: 'directory' }];
		fetchMock.mockResolvedValue(jsonResponse(payload));

		const result = await getTree({ chatId: 'c-1', projectPath: '/p' });

		expect(result).toEqual(payload);
		const [url] = fetchMock.mock.calls[0];
		expect(url).toContain('/api/v1/files/tree');
		expect(url).toContain('chatId=c-1');
	});

	it('getTree sends dirPath when provided', async () => {
		fetchMock.mockResolvedValue(jsonResponse([]));

		await getTree({ chatId: 'c-1', projectPath: '/p', dirPath: '/src' });

		const [url] = fetchMock.mock.calls[0];
		expect(url).toContain('path=%2Fsrc');
	});

	it('getFileList calls GET /api/v1/files/list', async () => {
		const payload = [{ name: 'a.ts', path: '/p/a.ts' }];
		fetchMock.mockResolvedValue(jsonResponse(payload));

		const result = await getFileList({ projectPath: '/p' });

		expect(result).toEqual(payload);
		const [url] = fetchMock.mock.calls[0];
		expect(url).toContain('/api/v1/files/list');
		expect(url).toContain('projectPath=%2Fp');
	});

	it('readText calls GET /api/v1/files/text with path', async () => {
		const payload = { content: 'hello world' };
		fetchMock.mockResolvedValue(jsonResponse(payload));

		const result = await readText({ chatId: 'c-1', filePath: '/p/a.ts' });

		expect(result.content).toBe('hello world');
		const [url] = fetchMock.mock.calls[0];
		expect(url).toContain('/api/v1/files/text');
		expect(url).toContain('path=%2Fp%2Fa.ts');
	});

	it('saveText calls PUT /api/v1/files/text with content body', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ success: true }));

		const result = await saveText({
			chatId: 'c-1',
			filePath: '/p/a.ts',
			content: 'new content',
		});

		expect(result).toEqual({ success: true });
		const [url, opts] = fetchMock.mock.calls[0];
		expect(url).toContain('/api/v1/files/text');
		expect(opts.method).toBe('PUT');
		const body = JSON.parse(opts.body);
		expect(body.content).toBe('new content');
	});

	it('validateDir calls GET /api/v1/files/validate-dir', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ valid: true, path: '/p' }));

		const result = await validateDir('/p');

		expect(result.valid).toBe(true);
		const [url] = fetchMock.mock.calls[0];
		expect(url).toContain('/api/v1/files/validate-dir');
		expect(url).toContain('path=%2Fp');
	});

	it('validateDir propagates ApiError on 400', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ error: 'Invalid path' }, 400));

		await expect(validateDir('/bad')).rejects.toMatchObject({ message: 'Invalid path' });
	});

	it('browseDirectory calls GET /api/v1/files/browse and returns raw array', async () => {
		const payload = [{ name: 'src', path: '/p/src', type: 'directory' }];
		fetchMock.mockResolvedValue(jsonResponse(payload));

		const result = await browseDirectory('/p');

		expect(result).toHaveLength(1);
		expect(result[0]).toEqual({ name: 'src', path: '/p/src', type: 'directory' });
		const [url] = fetchMock.mock.calls[0];
		expect(url).toContain('/api/v1/files/browse');
		expect(url).toContain('path=%2Fp');
	});

	it('browseDirectory rejects non-array payloads', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ entries: [] }));

		await expect(browseDirectory('/p')).rejects.toThrow('Invalid directory browse payload');
	});
});
