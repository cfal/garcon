import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as filesApi from '$lib/api/files';
import { FileViewerHostState } from '../file-viewer-host-state.svelte';
import type { FileViewerRequest } from '$lib/stores/file-viewer.svelte';

vi.mock('$lib/api/files', () => ({
	readText: vi.fn(),
	saveText: vi.fn(),
	getContentUrl: vi.fn(),
}));

function makeHost(): FileViewerHostState {
	return new FileViewerHostState({
		get request() {
			return null;
		},
		consumeRequest: () => null,
	});
}

function makeRequest(
	relativePath: string,
	preferredMode: FileViewerRequest['preferredMode'] = 'auto',
) {
	return {
		chatId: 'chat-1',
		fileRootPath: '/workspace',
		relativePath,
		source: 'markdown-link',
		preferredMode,
		requestedAt: Date.now(),
	} satisfies FileViewerRequest;
}

function deferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason?: unknown) => void;
} {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((promiseResolve, promiseReject) => {
		resolve = promiseResolve;
		reject = promiseReject;
	});
	return { promise, resolve, reject };
}

describe('FileViewerHostState', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(filesApi.readText).mockResolvedValue({ content: '# Readme' });
		vi.mocked(filesApi.saveText).mockResolvedValue({ success: true });
		vi.mocked(filesApi.getContentUrl).mockReturnValue('/content-url');
	});

	it('reads text through explicit fileRootPath without chatId', async () => {
		const host = makeHost();

		await host.openFromRequest(makeRequest('other/README.md'));

		expect(filesApi.readText).toHaveBeenCalledWith(
			{ projectPath: '/workspace', filePath: 'other/README.md' },
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
	});

	it('saves text through explicit fileRootPath without chatId', async () => {
		const host = makeHost();
		await host.openFromRequest(makeRequest('other/README.md'));

		host.setEditorContent('# Updated');
		await host.saveCurrentFile();

		expect(filesApi.saveText).toHaveBeenCalledWith({
			projectPath: '/workspace',
			filePath: 'other/README.md',
			content: '# Updated',
		});
	});

	it('builds image URLs through explicit fileRootPath without chatId', async () => {
		const host = makeHost();
		await host.openFromRequest(makeRequest('assets/logo.png'));

		expect(host.getImageUrl()).toBe('/content-url');
		expect(filesApi.getContentUrl).toHaveBeenCalledWith({
			projectPath: '/workspace',
			filePath: 'assets/logo.png',
		});
	});

	it('exposes a loading session before text content resolves', async () => {
		const host = makeHost();
		const read = deferred<{ content: string }>();
		vi.mocked(filesApi.readText).mockReturnValue(read.promise);

		const openPromise = host.openFromRequest(makeRequest('src/app.ts'));

		expect(host.session?.relativePath).toBe('src/app.ts');
		expect(host.loading).toBe(true);
		expect(host.file).toBeNull();
		expect(host.loadError).toBeNull();

		read.resolve({ content: 'export const value = 1;' });
		await openPromise;

		expect(host.loading).toBe(false);
		expect(host.file?.content).toBe('export const value = 1;');
	});

	it('clears stale file content while a new text file is loading', async () => {
		const host = makeHost();
		await host.openFromRequest(makeRequest('first.ts'));
		expect(host.file?.path).toBe('first.ts');

		const read = deferred<{ content: string }>();
		vi.mocked(filesApi.readText).mockReturnValue(read.promise);

		const openPromise = host.openFromRequest(makeRequest('second.ts'));

		expect(host.session?.relativePath).toBe('second.ts');
		expect(host.loading).toBe(true);
		expect(host.file).toBeNull();

		read.resolve({ content: 'second' });
		await openPromise;

		expect(host.file?.path).toBe('second.ts');
		expect(host.file?.content).toBe('second');
	});

	it('keeps the requested session visible when text loading fails', async () => {
		const host = makeHost();
		vi.mocked(filesApi.readText).mockRejectedValue(new Error('not found'));

		await host.openFromRequest(makeRequest('missing.ts'));

		expect(host.session?.relativePath).toBe('missing.ts');
		expect(host.loading).toBe(false);
		expect(host.file).toBeNull();
		expect(host.loadError).toBe('not found');
	});

	it('aborts an in-flight read when the viewer is closed', async () => {
		const host = makeHost();
		let aborted = false;
		vi.mocked(filesApi.readText).mockImplementation((_params, options) => {
			const signal = options?.signal;
			return new Promise((_, reject) => {
				signal?.addEventListener('abort', () => {
					aborted = true;
					const error = new Error('aborted');
					error.name = 'AbortError';
					reject(error);
				});
			});
		});

		const openPromise = host.openFromRequest(makeRequest('slow.ts'));
		expect(host.loading).toBe(true);

		host.closeViewer();
		await openPromise;

		expect(aborted).toBe(true);
		expect(host.session).toBeNull();
		expect(host.file).toBeNull();
		expect(host.loading).toBe(false);
	});
});
