import { cleanup, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import GitCommitChangedFileList from '../GitCommitChangedFileList.svelte';

describe('GitCommitChangedFileList', () => {
	afterEach(cleanup);

	it('keeps the mounted file rows bounded for large comparisons', () => {
		const files = Array.from({ length: 5_000 }, (_, index) => ({
			path: `src/file-${index}.ts`,
			status: 'modified' as const,
			rawStatus: 'M',
			category: 'normal' as const,
			additions: 1,
			deletions: 1,
			estimatedRows: 2,
			bodyState: 'unloaded' as const,
			bodyFingerprint: `fp-${index}`,
			isGenerated: false,
			isBinary: false,
			isTooLarge: false,
		}));

		const { container } = render(GitCommitChangedFileList, {
			files,
			fileFilter: '',
			focusedFilePath: null,
			onFileFilterChange: vi.fn(),
			onSelectFile: vi.fn(),
		});

		expect(container.querySelectorAll('[data-git-file-list-row]').length).toBeLessThan(50);
	});
});
