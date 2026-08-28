import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	getGitCommitFileBodies,
	getGitCommitSnapshot,
	getGitHistoryCommits,
	type GitDiffFileRequest,
} from '$lib/api/git.js';
import {
	getGitComparisonSnapshot,
	type GitComparisonSnapshotReady,
} from '$lib/api/git-comparison.js';
import {
	installResizeObserverHarness,
	ResizeObserverHarness,
} from '$lib/components/shared/__tests__/resize-observer-harness';
import {
	GitHistoryController,
	type GitHistoryRevertTarget,
} from '$lib/git/history/git-history.svelte.js';
import { GitHistoryComparisonSelectionState } from '$lib/git/history/git-history-comparison-selection.svelte.js';
import { createGitPatchIndex } from '$lib/git/review/git-patch-index.js';
import { LOCAL_STORAGE_KEYS } from '$lib/utils/local-persistence';
import { installGitVirtualDiffTestLayout } from './git-virtual-diff-test-layout.js';
import GitHistoryView from '../GitHistoryView.svelte';

vi.mock('$lib/components/workspace/WorkspaceFullscreenButton.svelte', async () => ({
	default: (await import('./WorkspaceFullscreenButtonStub.svelte')).default,
}));

vi.mock('$lib/api/git.js', () => ({
	getGitHistoryCommits: vi.fn(),
	getGitCommitSnapshot: vi.fn(),
	getGitCommitFileBodies: vi.fn(),
}));

vi.mock('$lib/api/git-comparison.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/api/git-comparison.js')>();
	return {
		...actual,
		getGitComparisonFreshness: vi.fn(),
		getGitComparisonSnapshot: vi.fn(),
		getGitComparisonFileBodies: vi.fn(),
	};
});

const limits = {
	maxSummaryFiles: 1000,
	maxBodyBatchFiles: 24,
	maxLoadedRows: 10_000,
	maxLoadedPatchBytes: 1024 * 1024,
	maxFileRows: 10_000,
	maxFilePatchBytes: 1024 * 1024,
	maxLineBytes: 20_000,
	maxContextLines: 50,
	bodyConcurrency: 4,
};

function commitListItem() {
	return {
		hash: 'abcdef1234567890',
		shortHash: 'abcdef1',
		parents: ['parent'],
		author: 'Test User',
		authorEmail: 'test@example.com',
		authorDate: '2026-01-01T00:00:00.000Z',
		committer: 'Test User',
		committerEmail: 'test@example.com',
		committerDate: '2026-01-01T00:00:00.000Z',
		subject: 'List commit',
		refs: [],
	};
}

function commitFile(path: string, fingerprint: string) {
	return {
		path,
		status: 'modified' as const,
		rawStatus: 'M',
		category: 'normal' as const,
		additions: 1,
		deletions: 0,
		estimatedRows: 2,
		bodyState: 'unloaded' as const,
		bodyFingerprint: fingerprint,
		isGenerated: false,
		isBinary: false,
		isTooLarge: false,
	};
}

function commitFiles() {
	return [
		commitFile('a.ts', 'fp-a'),
		...Array.from({ length: 18 }, (_, index) =>
			commitFile(`middle-${index}.ts`, `fp-middle-${index}`),
		),
		commitFile('later.ts', 'fp-later'),
	];
}

function snapshot() {
	return {
		status: 'ready' as const,
		project: '/project',
		documentId: 'doc-abc',
		commit: {
			...commitListItem(),
			subject: 'Commit detail',
			body: '',
		},
		selectedParent: 'parent',
		parentOptions: [{ hash: 'parent', shortHash: 'parent', label: 'Parent 1' }],
		files: commitFiles(),
		limits,
		firstBodyCandidates: ['a.ts'],
	};
}

function comparisonSnapshot(): GitComparisonSnapshotReady {
	return {
		status: 'ready',
		project: '/project',
		repoRoot: '/repo',
		documentId: 'comparison-doc',
		mode: 'direct',
		from: {
			kind: 'revision',
			requestedRevision: 'older',
			label: 'older',
			hash: 'a'.repeat(40),
			shortHash: 'aaaaaaa',
		},
		to: {
			kind: 'revision',
			requestedRevision: 'newer',
			label: 'newer',
			hash: 'b'.repeat(40),
			shortHash: 'bbbbbbb',
		},
		effectiveFromHash: 'a'.repeat(40),
		files: [],
		limits,
		firstBodyCandidates: [],
	};
}

function fingerprintForPath(path: string): string {
	if (path === 'a.ts') return 'fp-a';
	if (path === 'later.ts') return 'fp-later';
	const match = /^middle-(\d+)\.ts$/.exec(path);
	return match ? `fp-middle-${match[1]}` : `fp-${path}`;
}

function bodyForPath(path: string) {
	const text = path === 'later.ts' ? 'later line' : 'added line';
	const patch = `diff --git a/${path} b/${path}\n@@ -0,0 +1 @@\n+${text}\n`;
	return {
		path,
		bodyFingerprint: fingerprintForPath(path),
		bodyState: 'loaded' as const,
		category: 'normal' as const,
		isBinary: false,
		isTooLarge: false,
		renderedRowCount: 2,
		patchBytes: patch.length,
		patch,
		patchIndex: createGitPatchIndex(patch),
	};
}

function bodiesForPaths(paths: string[]) {
	return {
		status: 'ready' as const,
		documentId: 'doc-abc',
		files: Object.fromEntries(paths.map((path) => [path, bodyForPath(path)])),
		errors: {},
	};
}

function requestedPaths(files: GitDiffFileRequest[]): string[] {
	return files.map((file) => file.path);
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((promiseResolve, promiseReject) => {
		resolve = promiseResolve;
		reject = promiseReject;
	});
	return { promise, resolve, reject };
}

function createHistory(): GitHistoryController {
	const history = new GitHistoryController();
	void history.loadInitial('/project');
	return history;
}

describe('GitHistoryView', () => {
	let onRevertCommit: ReturnType<typeof vi.fn<(commit: GitHistoryRevertTarget) => void>>;
	let comparisonSelection: GitHistoryComparisonSelectionState;
	let restoreResizeObserver: () => void;

	beforeEach(() => {
		restoreResizeObserver = installResizeObserverHarness();
		vi.clearAllMocks();
		localStorage.removeItem(LOCAL_STORAGE_KEYS.gitTreePaneWidthPx);
		localStorage.removeItem(LOCAL_STORAGE_KEYS.gitDiffDocumentFileTreeVisible);
		onRevertCommit = vi.fn<(commit: GitHistoryRevertTarget) => void>();
		comparisonSelection = new GitHistoryComparisonSelectionState();
		vi.mocked(getGitHistoryCommits).mockResolvedValue({
			project: '/project',
			ref: 'HEAD',
			commits: [commitListItem()],
			nextOffset: null,
		});
		vi.mocked(getGitCommitSnapshot).mockResolvedValue(snapshot());
		vi.mocked(getGitCommitFileBodies).mockImplementation(
			async (_project, _documentId, _commit, files) => bodiesForPaths(requestedPaths(files)),
		);
		vi.mocked(getGitComparisonSnapshot).mockResolvedValue(comparisonSnapshot());
	});

	afterEach(() => {
		restoreResizeObserver();
		vi.restoreAllMocks();
		localStorage.removeItem(LOCAL_STORAGE_KEYS.gitTreePaneWidthPx);
		localStorage.removeItem(LOCAL_STORAGE_KEYS.gitDiffDocumentFileTreeVisible);
	});

	it('navigates from commit list to details and back', async () => {
		const history = createHistory();
		const { container } = render(GitHistoryView, {
			props: {
				history,
				comparisonSelection,
				onOpenSelectedComparison: vi.fn(),
				onOpenChat: vi.fn(),
				projectPath: '/project',
				presentation: 'pane-main',
				diffMode: 'unified',
				contextLines: 5,
				diffFontSize: 12,
				onRevertCommit,
			},
		});

		await screen.findByText('List commit');
		const list = container.querySelector<HTMLElement>('[data-git-history-commit-list]');
		expect(list?.dataset.workspaceScrollRegion).toBe('primary');
		expect(list?.contains(screen.getByRole('button', { name: 'Select commits' }))).toBe(false);
		const commitRow = screen.getByRole('button', { name: 'Open commit List commit' });
		expect(commitRow.hasAttribute('data-git-history-commit-row')).toBe(true);
		expect(commitRow.parentElement?.classList.contains('select-none')).toBe(true);
		await fireEvent.click(commitRow);

		await screen.findByText('Commit detail');
		await waitFor(() => {
			expect(screen.queryByText('Loading commit details')).toBeNull();
		});
		await waitFor(() => {
			expect(getGitCommitFileBodies).toHaveBeenCalled();
		});
		expect(screen.getByRole('button', { name: /diff settings/i })).toBeTruthy();
		expect(screen.queryByRole('button', { name: /stage/i })).toBeNull();
		expect(screen.getAllByText('a.ts').length).toBeGreaterThan(0);
		await fireEvent.click(screen.getByRole('button', { name: 'Revert' }));
		expect(onRevertCommit).toHaveBeenCalledWith({
			hash: 'abcdef1234567890',
			shortHash: 'abcdef1',
			subject: 'Commit detail',
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Back to commit history' }));

		expect(await screen.findByText('List commit')).toBeTruthy();
		expect(history.screen).toBe('list');
	});

	it('loads the next commit page automatically one viewport before the bottom', async () => {
		const nextPage = deferred<Awaited<ReturnType<typeof getGitHistoryCommits>>>();
		vi.mocked(getGitHistoryCommits)
			.mockResolvedValueOnce({
				project: '/project',
				ref: 'HEAD',
				commits: [commitListItem()],
				nextOffset: 50,
			})
			.mockReturnValueOnce(nextPage.promise);
		const history = createHistory();
		const { container } = render(GitHistoryView, {
			props: {
				history,
				comparisonSelection,
				onOpenSelectedComparison: vi.fn(),
				onOpenChat: vi.fn(),
				projectPath: '/project',
				presentation: 'pane-main',
				diffMode: 'unified',
				contextLines: 5,
				diffFontSize: 12,
				onRevertCommit,
			},
		});

		await screen.findByText('List commit');
		const list = container.querySelector<HTMLDivElement>('[data-git-history-commit-list]');
		expect(list).toBeTruthy();
		if (!list) return;
		Object.defineProperties(list, {
			clientHeight: { configurable: true, value: 200 },
			scrollHeight: { configurable: true, value: 1_000 },
		});

		list.scrollTop = 590;
		await fireEvent.scroll(list);
		expect(getGitHistoryCommits).toHaveBeenCalledOnce();

		list.scrollTop = 600;
		await fireEvent.scroll(list);
		await fireEvent.scroll(list);
		await waitFor(() => expect(getGitHistoryCommits).toHaveBeenCalledTimes(2));
		expect(getGitHistoryCommits).toHaveBeenLastCalledWith(
			'/project',
			expect.objectContaining({ offset: 50 }),
		);
		expect(screen.queryByRole('button', { name: /load more/i })).toBeNull();
		expect(screen.getByText('Loading more commits...')).toBeTruthy();

		nextPage.resolve({
			project: '/project',
			ref: 'HEAD',
			commits: [
				{
					...commitListItem(),
					hash: '1234567890abcdef',
					shortHash: '1234567',
					subject: 'Older commit',
				},
			],
			nextOffset: null,
		});

		expect(await screen.findByText('Older commit')).toBeTruthy();
		await waitFor(() => expect(screen.queryByText('Loading more commits...')).toBeNull());
	});

	it('offers an explicit retry instead of repeatedly auto-loading a failed page', async () => {
		vi.mocked(getGitHistoryCommits)
			.mockResolvedValueOnce({
				project: '/project',
				ref: 'HEAD',
				commits: [commitListItem()],
				nextOffset: 50,
			})
			.mockRejectedValueOnce(new Error('network unavailable'))
			.mockResolvedValueOnce({
				project: '/project',
				ref: 'HEAD',
				commits: [],
				nextOffset: null,
			});
		const history = createHistory();
		const { container } = render(GitHistoryView, {
			props: {
				history,
				comparisonSelection,
				onOpenSelectedComparison: vi.fn(),
				onOpenChat: vi.fn(),
				projectPath: '/project',
				presentation: 'pane-main',
				diffMode: 'unified',
				contextLines: 5,
				diffFontSize: 12,
				onRevertCommit,
			},
		});

		await screen.findByText('List commit');
		const list = container.querySelector<HTMLDivElement>('[data-git-history-commit-list]');
		expect(list).toBeTruthy();
		if (!list) return;
		Object.defineProperties(list, {
			clientHeight: { configurable: true, value: 200 },
			scrollHeight: { configurable: true, value: 1_000 },
		});
		list.scrollTop = 600;
		await fireEvent.scroll(list);

		const retry = await screen.findByRole('button', { name: 'Retry loading commits' });
		expect(screen.getByText('Failed to load more commits: network unavailable')).toBeTruthy();
		await fireEvent.scroll(list);
		await Promise.resolve();
		expect(getGitHistoryCommits).toHaveBeenCalledTimes(2);

		await fireEvent.click(retry);
		await waitFor(() => expect(getGitHistoryCommits).toHaveBeenCalledTimes(3));
		await waitFor(() =>
			expect(screen.queryByRole('button', { name: 'Retry loading commits' })).toBeNull(),
		);
	});

	it('resizes, hides, and restores the wide changed-file tree', async () => {
		const { container } = render(GitHistoryView, {
			props: {
				history: createHistory(),
				comparisonSelection,
				onOpenSelectedComparison: vi.fn(),
				onOpenChat: vi.fn(),
				projectPath: '/project',
				presentation: 'pane-main',
				diffMode: 'unified',
				contextLines: 5,
				diffFontSize: 12,
				onRevertCommit,
			},
		});

		await screen.findByText('List commit');
		await fireEvent.click(screen.getByRole('button', { name: /List commit/ }));
		await screen.findByText('Commit detail');
		const details = container.querySelector<HTMLElement>('[data-git-diff-document]');
		expect(details).toBeTruthy();
		if (!details) return;
		ResizeObserverHarness.emit(details, 1_100);
		await waitFor(() => expect(details.dataset.gitHistoryLayout).toBe('wide'));

		const panes = container.querySelector<HTMLElement>('[data-git-diff-document-panes]');
		const filesPane = container.querySelector<HTMLElement>('[data-git-history-files-pane]');
		const primaryHeader = container.querySelector('[data-git-commit-details-primary]');
		const fileTreeToggle = screen.getByRole('button', { name: 'Hide file tree' });
		const resizer = screen.getByRole('slider', { name: 'Resize file tree, 300 pixels' });
		expect(primaryHeader?.contains(fileTreeToggle)).toBe(true);
		expect(
			fileTreeToggle.nextElementSibling?.getAttribute('data-workspace-fullscreen-toggle'),
		).toBe('main');
		expect(panes?.style.gridTemplateColumns).toContain('300px 6px');

		await fireEvent.keyDown(resizer, { key: 'ArrowRight' });
		expect(panes?.style.gridTemplateColumns).toContain('316px 6px');
		expect(localStorage.getItem(LOCAL_STORAGE_KEYS.gitTreePaneWidthPx)).toBe('316');

		await fireEvent.click(fileTreeToggle);
		expect(filesPane?.getAttribute('aria-hidden')).toBe('true');
		expect(filesPane?.hasAttribute('inert')).toBe(true);
		expect(panes?.style.gridTemplateColumns).toBe('0px minmax(0,1fr)');
		expect(screen.queryByRole('slider', { name: /Resize file tree/ })).toBeNull();

		await fireEvent.click(screen.getByRole('button', { name: 'Show file tree' }));
		expect(filesPane?.getAttribute('aria-hidden')).toBe('false');
		expect(panes?.style.gridTemplateColumns).toContain('316px 6px');
		expect(screen.getByRole('slider', { name: 'Resize file tree, 316 pixels' })).toBeTruthy();
	});

	it('uses files and diff tabs on mobile commit details', async () => {
		const { container } = render(GitHistoryView, {
			props: {
				history: createHistory(),
				comparisonSelection,
				onOpenSelectedComparison: vi.fn(),
				onOpenChat: vi.fn(),
				projectPath: '/project',
				presentation: 'mobile',
				diffMode: 'unified',
				contextLines: 5,
				diffFontSize: 12,
				onRevertCommit,
			},
		});

		await screen.findByText('List commit');
		await fireEvent.click(screen.getByRole('button', { name: /List commit/ }));

		await screen.findByText('Commit detail');
		const details = container.querySelector<HTMLElement>('[data-git-diff-document]');
		expect(details).toBeTruthy();
		if (!details) return;
		ResizeObserverHarness.emit(details, 1_100);
		await waitFor(() => expect(details.dataset.gitHistoryLayout).toBe('narrow'));
		expect(container.querySelector('[data-workspace-fullscreen-toggle]')).toBeNull();

		const filesPane = container.querySelector<HTMLElement>('[data-git-history-files-pane]');
		const diffPane = container.querySelector<HTMLElement>('[data-git-history-diff-pane]');
		const diffRoot = container.querySelector('[data-git-virtual-diff-root]');
		expect(filesPane).toBeTruthy();
		expect(diffPane).toBeTruthy();
		expect(diffRoot).toBeTruthy();
		expect(filesPane?.getAttribute('aria-hidden')).toBe('false');
		expect(diffPane?.getAttribute('aria-hidden')).toBe('true');
		expect(filesPane?.hasAttribute('inert')).toBe(false);
		expect(diffPane?.hasAttribute('inert')).toBe(true);
		expect(diffPane?.classList.contains('pointer-events-none')).toBe(true);
		expect(screen.getByRole('button', { name: /Files/ })).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Diff' })).toBeTruthy();
		expect(screen.getByPlaceholderText('Filter files')).toBeTruthy();

		await waitFor(() => {
			expect(getGitCommitFileBodies).toHaveBeenCalled();
		});
		if (!filesPane) return;
		await fireEvent.click(within(filesPane).getByRole('treeitem', { name: /a.ts/ }));
		if (diffRoot) ResizeObserverHarness.emit(diffRoot, 480, 720);

		await screen.findAllByText('+added line');
		expect(filesPane.getAttribute('aria-hidden')).toBe('true');
		expect(diffPane?.getAttribute('aria-hidden')).toBe('false');
		expect(filesPane.hasAttribute('inert')).toBe(true);
		expect(filesPane.classList.contains('pointer-events-none')).toBe(true);
		expect(diffPane?.hasAttribute('inert')).toBe(false);
		expect(container.querySelector('[data-git-virtual-diff-root]')).toBe(diffRoot);
	});

	it('switches a narrow desktop container without remounting the diff', async () => {
		const { container } = render(GitHistoryView, {
			props: {
				history: createHistory(),
				comparisonSelection,
				onOpenSelectedComparison: vi.fn(),
				onOpenChat: vi.fn(),
				projectPath: '/project',
				presentation: 'pane-main',
				diffMode: 'unified',
				contextLines: 5,
				diffFontSize: 12,
				onRevertCommit,
			},
		});

		await screen.findByText('List commit');
		await fireEvent.click(screen.getByRole('button', { name: /List commit/ }));
		await screen.findByText('Commit detail');

		const details = container.querySelector<HTMLElement>('[data-git-diff-document]');
		expect(details).toBeTruthy();
		if (!details) return;
		ResizeObserverHarness.emit(details, 480);
		await waitFor(() => expect(details.dataset.gitHistoryLayout).toBe('narrow'));

		const filesPane = container.querySelector<HTMLElement>('[data-git-history-files-pane]');
		const diffPane = container.querySelector<HTMLElement>('[data-git-history-diff-pane]');
		const diffRoot = container.querySelector('[data-git-virtual-diff-root]');
		expect(filesPane?.getAttribute('aria-hidden')).toBe('false');
		expect(diffPane?.getAttribute('aria-hidden')).toBe('true');
		expect(diffRoot).toBeTruthy();

		await fireEvent.click(screen.getByRole('button', { name: 'Diff' }));
		expect(filesPane?.getAttribute('aria-hidden')).toBe('true');
		expect(diffPane?.getAttribute('aria-hidden')).toBe('false');
		expect(container.querySelector('[data-git-virtual-diff-root]')).toBe(diffRoot);

		await fireEvent.click(screen.getByRole('button', { name: /Files/ }));
		expect(filesPane?.getAttribute('aria-hidden')).toBe('false');
		expect(diffPane?.getAttribute('aria-hidden')).toBe('true');
		expect(container.querySelector('[data-git-virtual-diff-root]')).toBe(diffRoot);

		ResizeObserverHarness.emit(details, 560);
		await waitFor(() => expect(details.dataset.gitHistoryLayout).toBe('narrow'));
		expect(container.querySelector('[data-git-history-segmented-navigation]')).toBeTruthy();
		expect(filesPane?.getAttribute('aria-hidden')).toBe('false');
		expect(diffPane?.getAttribute('aria-hidden')).toBe('true');
		expect(container.querySelector('[data-git-virtual-diff-root]')).toBe(diffRoot);

		ResizeObserverHarness.emit(details, 840);
		await waitFor(() => expect(details.dataset.gitHistoryLayout).toBe('wide'));
		expect(container.querySelector('[data-git-history-segmented-navigation]')).toBeNull();
		expect(screen.getByRole('button', { name: 'Hide file tree' })).toBeTruthy();
		expect(screen.getByRole('slider', { name: /Resize file tree/ })).toBeTruthy();
		expect(filesPane?.getAttribute('aria-hidden')).toBe('false');
		expect(diffPane?.getAttribute('aria-hidden')).toBe('false');
		expect(container.querySelector('[data-git-virtual-diff-root]')).toBe(diffRoot);

		ResizeObserverHarness.emit(details, 480);
		await waitFor(() => expect(details.dataset.gitHistoryLayout).toBe('narrow'));
		expect(container.querySelector('[data-git-history-segmented-navigation]')).toBeTruthy();
		expect(filesPane?.getAttribute('aria-hidden')).toBe('false');
		expect(diffPane?.getAttribute('aria-hidden')).toBe('true');
		expect(container.querySelector('[data-git-virtual-diff-root]')).toBe(diffRoot);
	});

	it('loads the initially visible narrow diff without a scroll event', async () => {
		const layout = installGitVirtualDiffTestLayout({ viewportHeight: 720 });
		const files = Array.from({ length: 9 }, (_, index) =>
			commitFile(`file-${index}.ts`, `fp-file-${index}.ts`),
		);
		const firstBodyCandidates = files.slice(0, 8).map((file) => file.path);
		const firstVisible = deferred<ReturnType<typeof bodiesForPaths>>();
		vi.mocked(getGitCommitSnapshot).mockResolvedValue({
			...snapshot(),
			files,
			firstBodyCandidates,
		});
		vi.mocked(getGitCommitFileBodies)
			.mockReturnValueOnce(firstVisible.promise)
			.mockImplementation(async (_project, _documentId, _commit, files) =>
				bodiesForPaths(requestedPaths(files)),
			);
		const { container } = render(GitHistoryView, {
			props: {
				history: createHistory(),
				comparisonSelection,
				onOpenSelectedComparison: vi.fn(),
				onOpenChat: vi.fn(),
				projectPath: '/project',
				presentation: 'pane-main',
				diffMode: 'unified',
				contextLines: 5,
				diffFontSize: 12,
				onRevertCommit,
			},
		});

		await screen.findByText('List commit');
		await fireEvent.click(screen.getByRole('button', { name: /List commit/ }));
		await screen.findByText('Commit detail');
		await vi.waitFor(() => expect(getGitCommitFileBodies).toHaveBeenCalledTimes(2));
		const firstSignal = vi.mocked(getGitCommitFileBodies).mock.calls[0]?.[4]?.signal;
		const details = container.querySelector<HTMLElement>('[data-git-diff-document]');
		const diffRoot = container.querySelector<HTMLElement>('[data-git-virtual-diff-root]');
		expect(details).toBeTruthy();
		expect(diffRoot).toBeTruthy();
		if (!details || !diffRoot) return;
		ResizeObserverHarness.emit(details, 480);
		await waitFor(() => expect(details.dataset.gitHistoryLayout).toBe('narrow'));

		await fireEvent.click(screen.getByRole('button', { name: 'Diff' }));
		layout.setViewportHeight(3_000);
		ResizeObserverHarness.emit(diffRoot, 480, 3_000);
		await waitFor(() => {
			const requestedNinthFile = vi
				.mocked(getGitCommitFileBodies)
				.mock.calls.some(([, , , files]) => requestedPaths(files).includes('file-8.ts'));
			expect(requestedNinthFile).toBe(false);
			expect(firstSignal?.aborted).toBe(false);
		});

		firstVisible.resolve(bodiesForPaths([firstBodyCandidates[0]]));

		expect(await screen.findAllByText('+added line')).not.toHaveLength(0);
		await waitFor(() => {
			const requestedNinthFile = vi
				.mocked(getGitCommitFileBodies)
				.mock.calls.some(([, , , files]) => requestedPaths(files).includes('file-8.ts'));
			expect(requestedNinthFile).toBe(true);
		});
	});

	it('loads a selected file outside the initial body candidates in a narrow layout', async () => {
		installGitVirtualDiffTestLayout({ viewportHeight: 720 });
		const { container } = render(GitHistoryView, {
			props: {
				history: createHistory(),
				comparisonSelection,
				onOpenSelectedComparison: vi.fn(),
				onOpenChat: vi.fn(),
				projectPath: '/project',
				presentation: 'pane-main',
				diffMode: 'unified',
				contextLines: 5,
				diffFontSize: 12,
				onRevertCommit,
			},
		});

		await screen.findByText('List commit');
		await fireEvent.click(screen.getByRole('button', { name: /List commit/ }));
		await screen.findByText('Commit detail');

		const details = container.querySelector<HTMLElement>('[data-git-diff-document]');
		const filesPane = container.querySelector<HTMLElement>('[data-git-history-files-pane]');
		const diffRoot = container.querySelector<HTMLElement>('[data-git-virtual-diff-root]');
		expect(details).toBeTruthy();
		expect(filesPane).toBeTruthy();
		expect(diffRoot).toBeTruthy();
		if (!details || !filesPane || !diffRoot) return;
		ResizeObserverHarness.emit(details, 480);
		await waitFor(() => expect(details.dataset.gitHistoryLayout).toBe('narrow'));
		await waitFor(() => expect(getGitCommitFileBodies).toHaveBeenCalled());

		const requestedLaterBeforeSelection = vi
			.mocked(getGitCommitFileBodies)
			.mock.calls.some(([, , , files]) => requestedPaths(files).includes('later.ts'));
		expect(requestedLaterBeforeSelection).toBe(false);

		await fireEvent.click(within(filesPane).getByRole('treeitem', { name: /later\.ts/ }));

		await waitFor(() => {
			const requestedLaterFile = vi
				.mocked(getGitCommitFileBodies)
				.mock.calls.some(([, , , files]) => requestedPaths(files).includes('later.ts'));
			expect(requestedLaterFile).toBe(true);
		});
		ResizeObserverHarness.emit(diffRoot, 480, 720);
		expect(
			container.querySelector('[data-git-history-diff-pane]')?.getAttribute('aria-hidden'),
		).toBe('false');
		expect(await screen.findByText('+later line')).toBeTruthy();
	});

	it('keeps a delayed selected file targeted while the diff pane is hidden', async () => {
		const laterBodies = deferred<ReturnType<typeof bodiesForPaths>>();
		vi.mocked(getGitCommitFileBodies).mockImplementation(
			async (_project, _documentId, _commit, files) => {
				const paths = requestedPaths(files);
				if (paths.includes('later.ts')) return laterBodies.promise;
				return bodiesForPaths(paths);
			},
		);
		const history = createHistory();
		const { container } = render(GitHistoryView, {
			props: {
				history,
				comparisonSelection,
				onOpenSelectedComparison: vi.fn(),
				onOpenChat: vi.fn(),
				projectPath: '/project',
				presentation: 'pane-main',
				diffMode: 'unified',
				contextLines: 5,
				diffFontSize: 12,
				onRevertCommit,
			},
		});

		await screen.findByText('List commit');
		await fireEvent.click(screen.getByRole('button', { name: /List commit/ }));
		await screen.findByText('Commit detail');

		const details = container.querySelector<HTMLElement>('[data-git-diff-document]');
		const filesPane = container.querySelector<HTMLElement>('[data-git-history-files-pane]');
		const diffPane = container.querySelector<HTMLElement>('[data-git-history-diff-pane]');
		const diffRoot = container.querySelector<HTMLElement>('[data-git-virtual-diff-root]');
		expect(details).toBeTruthy();
		expect(filesPane).toBeTruthy();
		expect(diffPane).toBeTruthy();
		expect(diffRoot).toBeTruthy();
		if (!details || !filesPane || !diffPane || !diffRoot) return;
		ResizeObserverHarness.emit(details, 480);
		await waitFor(() => expect(details.dataset.gitHistoryLayout).toBe('narrow'));
		await waitFor(() => expect(history.document.fileBodies['a.ts']).toBeTruthy());
		expect(diffPane.getAttribute('aria-hidden')).toBe('true');
		vi.mocked(getGitCommitFileBodies).mockClear();

		await fireEvent.click(within(filesPane).getByRole('treeitem', { name: /later\.ts/ }));
		await waitFor(() => {
			const requestedLaterFile = vi
				.mocked(getGitCommitFileBodies)
				.mock.calls.some(([, , , files]) => requestedPaths(files).includes('later.ts'));
			expect(requestedLaterFile).toBe(true);
		});
		ResizeObserverHarness.emit(diffRoot, 480, 720);
		await fireEvent.click(screen.getByRole('button', { name: /Files/ }));
		expect(diffPane.getAttribute('aria-hidden')).toBe('true');

		laterBodies.resolve(bodiesForPaths(['later.ts']));
		expect(await screen.findByText('+later line')).toBeTruthy();
		await fireEvent.click(screen.getByRole('button', { name: 'Diff' }));

		expect(diffPane.getAttribute('aria-hidden')).toBe('false');
		expect(container.querySelector('[data-git-virtual-diff-root]')).toBe(diffRoot);
	});

	it('shows Revert only after opening commit details', async () => {
		render(GitHistoryView, {
			props: {
				history: createHistory(),
				comparisonSelection,
				onOpenSelectedComparison: vi.fn(),
				onOpenChat: vi.fn(),
				projectPath: '/project',
				presentation: 'pane-main',
				diffMode: 'unified',
				contextLines: 5,
				diffFontSize: 12,
				onRevertCommit,
			},
		});

		await screen.findByText('List commit');
		expect(screen.queryByRole('button', { name: 'Revert' })).toBeNull();
		expect(getGitCommitSnapshot).not.toHaveBeenCalled();

		await fireEvent.click(screen.getByRole('button', { name: 'Open commit List commit' }));

		await screen.findByText('Commit detail');
		expect(screen.getByRole('button', { name: 'Revert' })).toBeTruthy();
	});

	it('removes generic comparison launchers from the list and commit details', async () => {
		const history = createHistory();
		render(GitHistoryView, {
			props: {
				history,
				comparisonSelection,
				onOpenSelectedComparison: vi.fn(),
				onOpenChat: vi.fn(),
				projectPath: '/project',
				presentation: 'pane-main',
				diffMode: 'unified',
				contextLines: 5,
				diffFontSize: 12,
				onRevertCommit,
			},
		});

		await screen.findByText('List commit');
		expect(screen.queryByRole('button', { name: 'Compare revisions' })).toBeNull();
		expect(screen.getByRole('button', { name: 'Select commits' })).toBeTruthy();

		await fireEvent.click(screen.getByRole('button', { name: /List commit/ }));
		await screen.findByText('Commit detail');
		expect(screen.queryByRole('button', { name: 'Compare' })).toBeNull();
	});

	it('collects explicit commit endpoints before enabling the local comparison', async () => {
		const onOpenSelectedComparison = vi.fn();
		render(GitHistoryView, {
			props: {
				history: createHistory(),
				comparisonSelection,
				onOpenSelectedComparison,
				onOpenChat: vi.fn(),
				projectPath: '/project',
				presentation: 'pane-main',
				diffMode: 'unified',
				contextLines: 5,
				diffFontSize: 12,
				onRevertCommit,
			},
		});

		await screen.findByText('List commit');
		await fireEvent.click(screen.getByRole('button', { name: 'Select commits' }));
		expect(comparisonSelection.active).toBe(true);
		expect((screen.getByRole('button', { name: 'Compare' }) as HTMLButtonElement).disabled).toBe(
			true,
		);
		const commitButton = screen.getByRole('button', { name: 'Select List commit as From' });
		expect(commitButton.getAttribute('aria-pressed')).toBe('false');
		await fireEvent.click(commitButton);
		expect(
			screen.getByRole('button', { name: 'Select List commit as To', pressed: true }),
		).toBeTruthy();
		await fireEvent.click(
			screen.getByRole('button', { name: 'Select List commit as To', pressed: true }),
		);
		await fireEvent.click(screen.getByRole('button', { name: 'Compare' }));
		expect(onOpenSelectedComparison).toHaveBeenCalledOnce();
	});

	it('renders selected revisions inside History and returns to the preserved selection', async () => {
		const history = createHistory();
		history.saveListPosition({
			scrollTop: 0,
			anchorHash: commitListItem().hash,
			anchorOffset: 0,
			activeHash: commitListItem().hash,
		});
		comparisonSelection.begin();
		comparisonSelection.select('older');
		comparisonSelection.select('newer');
		const onOpenSelectedComparison = vi.fn(() => {
			const comparison = comparisonSelection.comparison();
			if (comparison) {
				history.openComparison('/project', comparison, {
					diffMode: 'unified',
					contextLines: 5,
				});
			}
		});
		const { container } = render(GitHistoryView, {
			props: {
				history,
				comparisonSelection,
				onOpenSelectedComparison,
				onOpenChat: vi.fn(),
				projectPath: '/project',
				presentation: 'pane-main',
				diffMode: 'unified',
				contextLines: 5,
				diffFontSize: 12,
				onRevertCommit,
			},
		});

		await screen.findByText('List commit');
		await fireEvent.click(screen.getByRole('button', { name: 'Compare' }));

		expect(onOpenSelectedComparison).toHaveBeenCalledOnce();
		expect(await screen.findByText('newer')).toBeTruthy();
		expect(screen.queryByText('Compare revisions')).toBeNull();
		expect(getGitComparisonSnapshot).toHaveBeenCalledWith(
			'/project',
			{ kind: 'revision', revision: 'older' },
			{ kind: 'revision', revision: 'newer' },
			'direct',
			expect.objectContaining({ context: 5 }),
		);
		expect(screen.queryByRole('button', { name: /Edit comparison/ })).toBeNull();
		const comparison = container.querySelector<HTMLElement>('[data-git-diff-document]');
		expect(comparison).toBeTruthy();
		if (!comparison) return;
		ResizeObserverHarness.emit(comparison, 1_100);
		await waitFor(() => expect(comparison.dataset.gitHistoryLayout).toBe('wide'));
		expect(
			screen
				.getByRole('button', { name: 'Hide file tree' })
				.nextElementSibling?.getAttribute('data-workspace-fullscreen-toggle'),
		).toBe('main');

		await fireEvent.click(screen.getByRole('button', { name: 'Back to commit selection' }));

		expect(await screen.findByText('List commit')).toBeTruthy();
		expect(history.listPosition).toMatchObject({
			anchorHash: commitListItem().hash,
			activeHash: commitListItem().hash,
		});
		expect(comparisonSelection).toMatchObject({
			active: true,
			from: 'older',
			to: 'newer',
		});
	});

	it('targets the sidebar host from commit details and omits the control from the list', async () => {
		const { container } = render(GitHistoryView, {
			props: {
				history: createHistory(),
				comparisonSelection,
				onOpenSelectedComparison: vi.fn(),
				onOpenChat: vi.fn(),
				projectPath: '/project',
				presentation: 'pane-sidebar',
				diffMode: 'unified',
				contextLines: 5,
				diffFontSize: 12,
				onRevertCommit,
			},
		});

		await screen.findByText('List commit');
		expect(container.querySelector('[data-workspace-fullscreen-toggle]')).toBeNull();
		await fireEvent.click(screen.getByRole('button', { name: /List commit/ }));
		await screen.findByText('Commit detail');
		const details = container.querySelector<HTMLElement>('[data-git-diff-document]');
		expect(details).toBeTruthy();
		if (!details) return;
		ResizeObserverHarness.emit(details, 1_100);
		await waitFor(() => expect(details.dataset.gitHistoryLayout).toBe('wide'));
		expect(
			screen
				.getByRole('button', { name: 'Hide file tree' })
				.nextElementSibling?.getAttribute('data-workspace-fullscreen-toggle'),
		).toBe('sidebar');
	});
});
