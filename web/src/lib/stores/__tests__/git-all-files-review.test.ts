import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GitFileReviewData, GitFileReviewMode, GitReviewDataProfile } from '$lib/api/git.js';
import { GitAllFilesReviewController } from '../git/git-all-files-review.svelte';

vi.mock('$lib/api/git.js', () => ({
	getGitFileReviewPreviewBatch: vi.fn(),
	getGitFileReviewFullBatch: vi.fn(),
}));

const gitApi = await import('$lib/api/git.js');
const mockedApi = vi.mocked(gitApi);

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function makeReviewData(
	path: string,
	mode: GitFileReviewMode = 'working',
	profile: GitReviewDataProfile = 'all-files-preview',
): GitFileReviewData {
	return {
		path,
		mode,
		profile,
		isBinary: false,
		truncated: false,
		rows: [],
		hunks: [],
	};
}

function createController(visibleFilePaths: () => string[]) {
	return new GitAllFilesReviewController({
		targetKey: () => '/project',
		targetProjectPath: () => '/project',
		activeTab: () => 'unstaged',
		contextLines: () => 5,
		visibleFilePaths,
		findTreeNode: () => undefined,
		surfaceError: vi.fn(),
	});
}

describe('GitAllFilesReviewController', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('prioritizes newly visible paths before stale pending preview work', async () => {
		const firstBatch = deferred<Awaited<ReturnType<typeof gitApi.getGitFileReviewPreviewBatch>>>();
		mockedApi.getGitFileReviewPreviewBatch
			.mockReturnValueOnce(firstBatch.promise)
			.mockResolvedValueOnce({
				files: {
					'new-1.ts': makeReviewData('new-1.ts'),
					'new-2.ts': makeReviewData('new-2.ts'),
					'old-9.ts': makeReviewData('old-9.ts'),
				},
				errors: {},
			});
		const controller = createController(() => []);

		controller.requestVisibleFiles(
			'/project',
			Array.from({ length: 9 }, (_, index) => `old-${index + 1}.ts`),
		);
		controller.requestVisibleFiles('/project', ['new-1.ts', 'new-2.ts']);

		expect(mockedApi.getGitFileReviewPreviewBatch).toHaveBeenNthCalledWith(
			1,
			'/project',
			['old-1.ts', 'old-2.ts', 'old-3.ts', 'old-4.ts', 'old-5.ts', 'old-6.ts', 'old-7.ts', 'old-8.ts'],
			'unstaged',
			5,
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);

		firstBatch.resolve({
			files: Object.fromEntries(
				Array.from({ length: 8 }, (_, index) => {
					const path = `old-${index + 1}.ts`;
					return [path, makeReviewData(path)];
				}),
			),
			errors: {},
		});

		await vi.waitFor(() => {
			expect(mockedApi.getGitFileReviewPreviewBatch).toHaveBeenCalledTimes(2);
		});
		expect(mockedApi.getGitFileReviewPreviewBatch).toHaveBeenNthCalledWith(
			2,
			'/project',
			['new-1.ts', 'new-2.ts', 'old-9.ts'],
			'unstaged',
			5,
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
	});

	it('does not let a preview cache entry satisfy a full-card request', async () => {
		mockedApi.getGitFileReviewPreviewBatch.mockResolvedValue({
			files: { 'a.ts': makeReviewData('a.ts', 'working', 'all-files-preview') },
			errors: {},
		});
		mockedApi.getGitFileReviewFullBatch.mockResolvedValue({
			files: { 'a.ts': makeReviewData('a.ts', 'working', 'all-files-full') },
			errors: {},
		});
		const controller = createController(() => ['a.ts']);

		controller.requestVisibleFiles('/project', ['a.ts']);
		await vi.waitFor(() => {
			expect(controller.reviewDataByPath['a.ts']?.profile).toBe('all-files-preview');
		});

		controller.loadFullFile('/project', 'a.ts');

		await vi.waitFor(() => {
			expect(controller.reviewDataByPath['a.ts']?.profile).toBe('all-files-full');
		});
		expect(mockedApi.getGitFileReviewFullBatch).toHaveBeenCalledWith(
			'/project',
			['a.ts'],
			'unstaged',
			5,
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
	});
});
