import { render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import * as filesApi from '$lib/api/files';
import { FileViewerStore } from '$lib/stores/file-viewer.svelte';
import FileViewerHostTestHost from './FileViewerHostTestHost.svelte';

vi.mock('$lib/api/files', () => ({
	readText: vi.fn(),
	saveText: vi.fn(),
	getContentUrl: vi.fn(),
}));

describe('FileViewerHost', () => {
	it('renders a loading dialog immediately after a file open request', async () => {
		vi.mocked(filesApi.readText).mockReturnValue(new Promise(() => {}));
		const viewer = new FileViewerStore();

		render(FileViewerHostTestHost, { viewer });
		viewer.openAuto({
			chatId: 'chat-1',
			fileRootPath: '/workspace',
			relativePath: 'src/app.ts',
			source: 'markdown-link',
		});

		expect(await screen.findByText('Opening file...')).toBeTruthy();
		expect(screen.getByText('app.ts')).toBeTruthy();
		expect(screen.getAllByText('src/app.ts')).toHaveLength(2);
	});
});
