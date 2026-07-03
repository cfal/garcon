import { cleanup, render, screen } from '@testing-library/svelte';
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

		// The dialog's bits-ui body-scroll-lock schedules a deferred (~24ms) cleanup
		// timer on unmount. Unmount here and let it fire while `document` still exists;
		// otherwise it runs after the test environment tears down and throws
		// "document is not defined", failing the suite even though assertions passed.
		cleanup();
		await new Promise((resolve) => setTimeout(resolve, 50));
	});
});
