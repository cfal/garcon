import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	getGitCommitFileBodies,
	getGitCommitSnapshot,
	getGitHistoryCommits,
	type GitDiffFileRequest,
} from '$lib/api/git.js';
import {
	installResizeObserverHarness,
	ResizeObserverHarness,
} from '$lib/components/shared/__tests__/resize-observer-harness';
import {
	GitHistoryController,
	type GitHistoryRevertTarget,
} from '$lib/git/history/git-history.svelte.js';
import {
	GIT_EMPTY_TREE_REVISION,
	GitComparisonController,
} from '$lib/git/review/git-comparison.svelte.js';
import { LOCAL_STORAGE_KEYS } from '$lib/utils/local-persistence';
import GitHistoryView from '../GitHistoryView.svelte';

vi.mock('$lib/api/git.js', () => ({
	getGitHistoryCommits: vi.fn(),
	getGitCommitSnapshot: vi.fn(),
	getGitCommitFileBodies: vi.fn(),
}));

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

function fingerprintForPath(path: string): string {
	if (path === 'a.ts') return 'fp-a';
	if (path === 'later.ts') return 'fp-later';
	const match = /^middle-(\d+)\.ts$/.exec(path);
	return match ? `fp-middle-${match[1]}` : `fp-${path}`;
}

function bodyForPath(path: string) {
	return {
		path,
		bodyFingerprint: fingerprintForPath(path),
		bodyState: 'loaded' as const,
		category: 'normal' as const,
		isBinary: false,
		isTooLarge: false,
		renderedRowCount: 2,
		patchBytes: 64,
		rows: [
			{
				key: `hunk:${path}`,
				kind: 'hunk' as const,
				text: '@@ -1 +1 @@',
				beforeLine: null,
				afterLine: null,
				hunkId: 'h0',
				hunkIndex: 0,
				diffLineIndex: -1,
			},
			{
				key: `add:${path}`,
				kind: 'add' as const,
				text: path === 'later.ts' ? 'later line' : 'added line',
				beforeLine: null,
				afterLine: 1,
				hunkId: 'h0',
				hunkIndex: 0,
				diffLineIndex: 0,
			},
		],
		hunks: [],
	};
}

function bodiesForPaths(paths: string[]) {
	return {
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

describe('GitHistoryView', () => {
	let onRevertCommit: ReturnType<typeof vi.fn<(commit: GitHistoryRevertTarget) => void>>;
	let comparison: GitComparisonController;
	let restoreResizeObserver: () => void;

	beforeEach(() => {
		restoreResizeObserver = installResizeObserverHarness();
		vi.clearAllMocks();
		localStorage.removeItem(LOCAL_STORAGE_KEYS.gitTreePaneWidthPx);
		localStorage.removeItem(LOCAL_STORAGE_KEYS.gitDiffDocumentFileTreeVisible);
		onRevertCommit = vi.fn<(commit: GitHistoryRevertTarget) => void>();
		comparison = new GitComparisonController();
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
	});

	afterEach(() => {
		restoreResizeObserver();
		localStorage.removeItem(LOCAL_STORAGE_KEYS.gitTreePaneWidthPx);
		localStorage.removeItem(LOCAL_STORAGE_KEYS.gitDiffDocumentFileTreeVisible);
	});

	it('navigates from commit list to details and back', async () => {
		const history = new GitHistoryController();
		render(GitHistoryView, {
			props: {
				history,
				comparison,
				onOpenComparison: vi.fn(),
				onOpenChat: vi.fn(),
				projectPath: '/project',
				effectiveProjectKey: '/project',
				isMobile: false,
				diffMode: 'unified',
				contextLines: 5,
				diffFontSize: 12,
				onRevertCommit,
			},
		});

		await screen.findByText('List commit');
		await fireEvent.click(screen.getByRole('button', { name: /List commit/ }));

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

	it('resizes, hides, and restores the wide changed-file tree', async () => {
		const { container } = render(GitHistoryView, {
			props: {
				history: new GitHistoryController(),
				comparison,
				onOpenComparison: vi.fn(),
				onOpenChat: vi.fn(),
				projectPath: '/project',
				effectiveProjectKey: '/project',
				isMobile: false,
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
		const resizer = screen.getByRole('slider', { name: 'Resize file tree, 300 pixels' });
		expect(panes?.style.gridTemplateColumns).toContain('300px 6px');

		await fireEvent.keyDown(resizer, { key: 'ArrowRight' });
		expect(panes?.style.gridTemplateColumns).toContain('316px 6px');
		expect(localStorage.getItem(LOCAL_STORAGE_KEYS.gitTreePaneWidthPx)).toBe('316');

		await fireEvent.click(screen.getByRole('button', { name: 'Hide file tree' }));
		expect(filesPane?.getAttribute('aria-hidden')).toBe('true');
		expect(filesPane?.hasAttribute('inert')).toBe(true);
		expect(panes?.style.gridTemplateColumns).toContain('0px 0px');
		expect(screen.queryByRole('slider', { name: /Resize file tree/ })).toBeNull();

		await fireEvent.click(screen.getByRole('button', { name: 'Show file tree' }));
		expect(filesPane?.getAttribute('aria-hidden')).toBe('false');
		expect(panes?.style.gridTemplateColumns).toContain('316px 6px');
		expect(screen.getByRole('slider', { name: 'Resize file tree, 316 pixels' })).toBeTruthy();
	});

	it('reloads the list when effective project identity changes at the same path', async () => {
		const history = new GitHistoryController();
		const props = {
			history,
			comparison,
			onOpenComparison: vi.fn(),
			onOpenChat: vi.fn(),
			projectPath: '/project',
			effectiveProjectKey: 'alpha',
			isMobile: false,
			diffMode: 'unified' as const,
			contextLines: 5,
			diffFontSize: 12,
			onRevertCommit,
		};
		const { rerender } = render(GitHistoryView, { props });
		await screen.findByText('List commit');
		expect(getGitHistoryCommits).toHaveBeenCalledTimes(1);
		history.screen = 'commit';

		await rerender({ ...props, effectiveProjectKey: 'beta' });

		await waitFor(() => {
			expect(history.screen).toBe('list');
			expect(getGitHistoryCommits).toHaveBeenCalledTimes(2);
		});
	});

	it('uses files and diff tabs on mobile commit details', async () => {
		const { container } = render(GitHistoryView, {
			props: {
				history: new GitHistoryController(),
				comparison,
				onOpenComparison: vi.fn(),
				onOpenChat: vi.fn(),
				projectPath: '/project',
				effectiveProjectKey: '/project',
				isMobile: true,
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
				history: new GitHistoryController(),
				comparison,
				onOpenComparison: vi.fn(),
				onOpenChat: vi.fn(),
				projectPath: '/project',
				effectiveProjectKey: '/project',
				isMobile: false,
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
		await waitFor(() => expect(details.dataset.gitHistoryLayout).toBe('compact'));
		expect(container.querySelector('[data-git-history-segmented-navigation]')).toBeNull();
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
		const files = Array.from({ length: 9 }, (_, index) =>
			commitFile(`file-${index}.ts`, `fp-file-${index}.ts`),
		);
		const firstBodyCandidates = files.slice(0, 8).map((file) => file.path);
		const firstBatch = deferred<ReturnType<typeof bodiesForPaths>>();
		vi.mocked(getGitCommitSnapshot).mockResolvedValue({
			...snapshot(),
			files,
			firstBodyCandidates,
		});
		vi.mocked(getGitCommitFileBodies)
			.mockReturnValueOnce(firstBatch.promise)
			.mockImplementation(async (_project, _documentId, _commit, files) =>
				bodiesForPaths(requestedPaths(files)),
			);
		const { container } = render(GitHistoryView, {
			props: {
				history: new GitHistoryController(),
				comparison,
				onOpenComparison: vi.fn(),
				onOpenChat: vi.fn(),
				projectPath: '/project',
				effectiveProjectKey: '/project',
				isMobile: false,
				diffMode: 'unified',
				contextLines: 5,
				diffFontSize: 12,
				onRevertCommit,
			},
		});

		await screen.findByText('List commit');
		await fireEvent.click(screen.getByRole('button', { name: /List commit/ }));
		await screen.findByText('Commit detail');
		await vi.waitFor(() => expect(getGitCommitFileBodies).toHaveBeenCalledTimes(1));
		const firstSignal = vi.mocked(getGitCommitFileBodies).mock.calls[0]?.[4]?.signal;
		const details = container.querySelector<HTMLElement>('[data-git-diff-document]');
		const diffRoot = container.querySelector<HTMLElement>('[data-git-virtual-diff-root]');
		expect(details).toBeTruthy();
		expect(diffRoot).toBeTruthy();
		if (!details || !diffRoot) return;
		ResizeObserverHarness.emit(details, 480);
		await waitFor(() => expect(details.dataset.gitHistoryLayout).toBe('narrow'));

		await fireEvent.click(screen.getByRole('button', { name: 'Diff' }));
		ResizeObserverHarness.emit(diffRoot, 480, 3_000);
		await waitFor(() => {
			const requestedNinthFile = vi
				.mocked(getGitCommitFileBodies)
				.mock.calls.some(([, , , files]) => requestedPaths(files).includes('file-8.ts'));
			expect(requestedNinthFile).toBe(false);
			expect(firstSignal?.aborted).toBe(false);
		});

		firstBatch.resolve(bodiesForPaths(firstBodyCandidates));

		expect(await screen.findAllByText('+added line')).not.toHaveLength(0);
		await waitFor(() => {
			const requestedNinthFile = vi
				.mocked(getGitCommitFileBodies)
				.mock.calls.some(([, , , files]) => requestedPaths(files).includes('file-8.ts'));
			expect(requestedNinthFile).toBe(true);
		});
	});

	it('loads a selected file outside the initial body candidates in a narrow layout', async () => {
		const { container } = render(GitHistoryView, {
			props: {
				history: new GitHistoryController(),
				comparison,
				onOpenComparison: vi.fn(),
				onOpenChat: vi.fn(),
				projectPath: '/project',
				effectiveProjectKey: '/project',
				isMobile: false,
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
		const { container } = render(GitHistoryView, {
			props: {
				history: new GitHistoryController(),
				comparison,
				onOpenComparison: vi.fn(),
				onOpenChat: vi.fn(),
				projectPath: '/project',
				effectiveProjectKey: '/project',
				isMobile: false,
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
		await waitFor(() => expect(screen.queryAllByText('+added line').length).toBeGreaterThan(0));
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

	it('reports list row revert requests without opening the commit', async () => {
		render(GitHistoryView, {
			props: {
				history: new GitHistoryController(),
				comparison,
				onOpenComparison: vi.fn(),
				onOpenChat: vi.fn(),
				projectPath: '/project',
				effectiveProjectKey: '/project',
				isMobile: false,
				diffMode: 'unified',
				contextLines: 5,
				diffFontSize: 12,
				onRevertCommit,
			},
		});

		await screen.findByText('List commit');
		await fireEvent.click(screen.getByRole('button', { name: 'Revert' }));

		expect(onRevertCommit).toHaveBeenCalledWith({
			hash: 'abcdef1234567890',
			shortHash: 'abcdef1',
			subject: 'List commit',
		});
		expect(getGitCommitSnapshot).not.toHaveBeenCalled();
	});

	it('routes History and commit comparison intents through the parent opener', async () => {
		const history = new GitHistoryController();
		const onOpenComparison = vi.fn();
		comparison.beginHistorySelection();
		comparison.selectHistoryCommit('older');
		comparison.selectHistoryCommit('newer');
		render(GitHistoryView, {
			props: {
				history,
				comparison,
				onOpenComparison,
				onOpenChat: vi.fn(),
				projectPath: '/project',
				effectiveProjectKey: '/project',
				isMobile: false,
				diffMode: 'unified',
				contextLines: 5,
				diffFontSize: 12,
				onRevertCommit,
			},
		});

		await screen.findByText('List commit');
		await fireEvent.click(screen.getByRole('button', { name: 'Compare' }));
		expect(onOpenComparison).toHaveBeenLastCalledWith({
			fromRevision: 'older',
			toKind: 'revision',
			toRevision: 'newer',
		});

		await fireEvent.click(screen.getByRole('button', { name: /List commit/ }));
		await screen.findByText('Commit detail');
		await fireEvent.click(screen.getByRole('button', { name: 'Compare' }));
		expect(onOpenComparison).toHaveBeenLastCalledWith({
			fromRevision: 'parent',
			toKind: 'revision',
			toRevision: 'abcdef1234567890',
		});
	});

	it('opens editable revision endpoints or explicit commit selection from History', async () => {
		const history = new GitHistoryController();
		const onOpenComparison = vi.fn();
		render(GitHistoryView, {
			props: {
				history,
				comparison,
				onOpenComparison,
				onOpenChat: vi.fn(),
				projectPath: '/project',
				effectiveProjectKey: '/project',
				isMobile: false,
				diffMode: 'unified',
				contextLines: 5,
				diffFontSize: 12,
				onRevertCommit,
			},
		});

		await screen.findByText('List commit');
		await fireEvent.click(screen.getByRole('button', { name: 'Compare revisions' }));
		expect(onOpenComparison).toHaveBeenCalledWith({
			fromRevision: 'parent',
			toKind: 'revision',
			toRevision: 'abcdef1234567890',
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Select commits' }));
		expect(comparison.historySelectionActive).toBe(true);
		const commitButton = screen.getByRole('button', { name: 'Select List commit as From' });
		expect(commitButton.getAttribute('aria-pressed')).toBe('false');
		await fireEvent.click(commitButton);
		expect(
			screen.getByRole('button', { name: 'Select List commit as To', pressed: true }),
		).toBeTruthy();
	});

	it('defaults an empty History comparison to the empty tree', async () => {
		vi.mocked(getGitHistoryCommits).mockResolvedValue({
			project: '/project',
			ref: 'HEAD',
			commits: [],
			nextOffset: null,
		});
		const onOpenComparison = vi.fn();
		render(GitHistoryView, {
			props: {
				history: new GitHistoryController(),
				comparison,
				onOpenComparison,
				onOpenChat: vi.fn(),
				projectPath: '/project',
				effectiveProjectKey: '/project',
				isMobile: false,
				diffMode: 'unified',
				contextLines: 5,
				diffFontSize: 12,
				onRevertCommit,
			},
		});

		await screen.findByText('No commits found');
		await fireEvent.click(screen.getByRole('button', { name: 'Compare revisions' }));

		expect(onOpenComparison).toHaveBeenCalledWith({
			fromRevision: GIT_EMPTY_TREE_REVISION,
			toKind: 'revision',
			toRevision: 'HEAD',
		});
	});
});
