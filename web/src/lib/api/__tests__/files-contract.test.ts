import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	getTree,
	getFileList,
	getFileRevision,
	readContent,
	getContentUrl,
	readText,
	resolveFileIdentity,
	saveText,
	browseDirectory,
} from '../files';

vi.stubGlobal('localStorage', {
	getItem: () => 'test-token',
	setItem: () => {},
	removeItem: () => {},
});

describe('files API contract', () => {
	let fetchMock: ReturnType<typeof vi.fn>;
	const treePayload = {
		fileRootPath: '/workspace',
		directory: {
			path: '/workspace/project',
			relativePath: 'project',
			parentPath: '/workspace',
			breadcrumbs: [
				{ name: 'workspace', path: '/workspace' },
				{ name: 'project', path: '/workspace/project' },
			],
		},
		entries: [
			{
				name: 'src',
				path: '/workspace/project/src',
				relativePath: 'project/src',
				type: 'directory',
				size: 4096,
				modified: null,
				permissionsRwx: 'rwxr-xr-x',
			},
		],
	};

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

	it('getTree calls the base-scoped endpoint without project selectors', async () => {
		fetchMock.mockResolvedValue(jsonResponse(treePayload));

		const result = await getTree();

		expect(result).toEqual(treePayload);
		const [url] = fetchMock.mock.calls[0];
		expect(url).toBe('/api/v1/files/tree');
	});

	it('getTree sends an encoded directory path and forwards the abort signal', async () => {
		fetchMock.mockResolvedValue(jsonResponse(treePayload));
		const controller = new AbortController();

		await getTree({ directoryPath: '/workspace/project/src' }, { signal: controller.signal });

		const [url, options] = fetchMock.mock.calls[0];
		expect(url).toContain('path=%2Fworkspace%2Fproject%2Fsrc');
		expect(options.signal).toBeInstanceOf(AbortSignal);
	});

	it('getTree rejects malformed response fields', async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({ ...treePayload, directory: { ...treePayload.directory, breadcrumbs: [] } }),
		);

		await expect(getTree()).rejects.toThrow('Invalid file tree response');
	});

	it('getTree rejects inconsistent base and directory metadata', async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({
				...treePayload,
				directory: { ...treePayload.directory, relativePath: '', parentPath: null },
			}),
		);

		await expect(getTree()).rejects.toThrow('Invalid file tree response');
	});

	it('getTree rejects malformed entry metadata', async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({
				...treePayload,
				entries: [{ ...treePayload.entries[0], modified: 'not-a-date' }],
			}),
		);

		await expect(getTree()).rejects.toThrow('Invalid file tree response');
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
		const payload = { content: 'hello world', path: '/p/a.ts', revision: 'v1:loaded' };
		fetchMock.mockResolvedValue(jsonResponse(payload));

		const result = await readText({ chatId: 'c-1', filePath: '/p/a.ts' });

		expect(result.content).toBe('hello world');
		const [url] = fetchMock.mock.calls[0];
		expect(url).toContain('/api/v1/files/text');
		expect(url).toContain('path=%2Fp%2Fa.ts');
	});

	it('gets and validates ready and missing file revisions', async () => {
		fetchMock
			.mockResolvedValueOnce(jsonResponse({ status: 'ready', revision: 'v1:latest' }))
			.mockResolvedValueOnce(jsonResponse({ status: 'missing' }));

		await expect(
			getFileRevision({ projectPath: '/p', filePath: 'a.ts' }),
		).resolves.toEqual({ status: 'ready', revision: 'v1:latest' });
		await expect(
			getFileRevision({ projectPath: '/p', filePath: 'a.ts' }),
		).resolves.toEqual({ status: 'missing' });
		expect(fetchMock.mock.calls[0][0]).toContain('/api/v1/files/revision');
	});

	it('rejects malformed revision and text responses', async () => {
		fetchMock
			.mockResolvedValueOnce(jsonResponse({ status: 'ready', revision: 'bad' }))
			.mockResolvedValueOnce(jsonResponse({ content: 'text', path: '/p/a.ts' }));

		await expect(
			getFileRevision({ projectPath: '/p', filePath: 'a.ts' }),
		).rejects.toThrow('Invalid file revision response');
		await expect(readText({ projectPath: '/p', filePath: 'a.ts' })).rejects.toThrow(
			'Invalid file text response',
		);
	});

	it('reads raw content with its response revision', async () => {
		fetchMock.mockResolvedValue(
			new Response('image', { headers: { 'X-Garcon-File-Revision': 'v1:image' } }),
		);

		const result = await readContent({ projectPath: '/p', filePath: 'image.png' });

		expect(await result.blob.text()).toBe('image');
		expect(result.revision).toBe('v1:image');
	});

	it('rejects raw content without a valid revision header', async () => {
		fetchMock.mockResolvedValue(new Response('image'));

		await expect(
			readContent({ projectPath: '/p', filePath: 'image.png' }),
		).rejects.toThrow('Invalid file content revision');
	});

	it('builds a content URL with encoded canonical project and file paths', () => {
		expect(
			getContentUrl({
				projectPath: '/workspace/project with spaces',
				filePath: 'assets/logo mark.png',
			}),
		).toBe(
			'/api/v1/files/content?path=assets%2Flogo+mark.png&projectPath=%2Fworkspace%2Fproject+with+spaces',
		);
	});

	it('resolves and validates canonical file identity', async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({
				success: true,
				identity: {
					canonicalFileRootPath: '/workspace/project',
					normalizedRelativePath: 'src/file.ts',
				},
			}),
		);

		await expect(
			resolveFileIdentity({
				chatId: 'chat-1',
				projectPath: null,
				relativePath: 'alias/file.ts',
			}),
		).resolves.toEqual({
			success: true,
			identity: {
				canonicalFileRootPath: '/workspace/project',
				normalizedRelativePath: 'src/file.ts',
			},
		});
		const [url] = fetchMock.mock.calls[0];
		expect(url).toContain('/api/v1/files/identity');
		expect(url).toContain('chatId=chat-1');
		expect(url).toContain('path=alias%2Ffile.ts');
	});

	it('rejects an invalid canonical file identity payload', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ success: true, identity: { path: 'file.ts' } }));

		await expect(
			resolveFileIdentity({
				chatId: null,
				projectPath: '/workspace/project',
				relativePath: 'file.ts',
			}),
		).rejects.toThrow('Invalid file identity response');
	});

	it('saveText sends a revision-checked content body', async () => {
		const response = {
			success: true,
			path: '/p/a.ts',
			message: 'File saved successfully',
			revision: 'v1:saved',
		};
		fetchMock.mockResolvedValue(jsonResponse(response));
		const controller = new AbortController();

		const result = await saveText(
			{
				chatId: 'c-1',
				filePath: '/p/a.ts',
				content: 'new content',
				expectedRevision: 'v1:loaded',
				conflictResolution: 'reject',
			},
			{ signal: controller.signal },
		);

		expect(result).toEqual(response);
		const [url, opts] = fetchMock.mock.calls[0];
		expect(url).toContain('/api/v1/files/text');
		expect(opts.method).toBe('PUT');
		expect(opts.signal).toBeInstanceOf(AbortSignal);
		controller.abort();
		expect(opts.signal.aborted).toBe(true);
		expect(JSON.parse(opts.body)).toEqual({
			content: 'new content',
			expectedRevision: 'v1:loaded',
			conflictResolution: 'reject',
		});
	});

	it('preserves a structured file revision conflict', async () => {
		fetchMock.mockResolvedValue(
			jsonResponse(
				{
					success: false,
					error: 'File changed on disk',
					errorCode: 'FILE_REVISION_CONFLICT',
					retryable: false,
				},
				409,
			),
		);

		await expect(
			saveText({
				projectPath: '/p',
				filePath: 'a.ts',
				content: 'local',
				expectedRevision: 'v1:loaded',
				conflictResolution: 'reject',
			}),
		).rejects.toMatchObject({
			status: 409,
			errorCode: 'FILE_REVISION_CONFLICT',
			retryable: false,
		});
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
