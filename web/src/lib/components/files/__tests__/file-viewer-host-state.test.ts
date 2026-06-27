import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as filesApi from '$lib/api/files';
import { FileViewerHostState } from '../file-viewer-host-state.svelte';

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

describe('FileViewerHostState', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(filesApi.readText).mockResolvedValue({ content: '# Readme' });
		vi.mocked(filesApi.saveText).mockResolvedValue({ success: true });
		vi.mocked(filesApi.getContentUrl).mockReturnValue('/content-url');
	});

	it('reads text through explicit fileRootPath without chatId', async () => {
		const host = makeHost();

		await host.openFromRequest({
			chatId: 'chat-1',
			fileRootPath: '/workspace',
			relativePath: 'other/README.md',
			source: 'markdown-link',
			preferredMode: 'auto',
			requestedAt: Date.now(),
		});

		expect(filesApi.readText).toHaveBeenCalledWith(
			{ projectPath: '/workspace', filePath: 'other/README.md' },
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
	});

	it('saves text through explicit fileRootPath without chatId', async () => {
		const host = makeHost();
		await host.openFromRequest({
			chatId: 'chat-1',
			fileRootPath: '/workspace',
			relativePath: 'other/README.md',
			source: 'markdown-link',
			preferredMode: 'auto',
			requestedAt: Date.now(),
		});

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
		await host.openFromRequest({
			chatId: 'chat-1',
			fileRootPath: '/workspace',
			relativePath: 'assets/logo.png',
			source: 'markdown-link',
			preferredMode: 'auto',
			requestedAt: Date.now(),
		});

		expect(host.getImageUrl()).toBe('/content-url');
		expect(filesApi.getContentUrl).toHaveBeenCalledWith({
			projectPath: '/workspace',
			filePath: 'assets/logo.png',
		});
	});
});
