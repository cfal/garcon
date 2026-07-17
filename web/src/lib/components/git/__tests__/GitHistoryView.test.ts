import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	getGitCommitFileBodies,
	getGitCommitSnapshot,
	getGitHistoryCommits,
} from '$lib/api/git.js';
import {
	installResizeObserverHarness,
	ResizeObserverHarness,
} from '$lib/components/shared/__tests__/resize-observer-harness';
import type { GitHistoryRevertTarget } from '$lib/git/history/git-history.svelte.js';
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

describe('GitHistoryView', () => {
	let onRevertCommit: ReturnType<typeof vi.fn<(commit: GitHistoryRevertTarget) => void>>;
	let restoreResizeObserver: () => void;

	beforeEach(() => {
		restoreResizeObserver = installResizeObserverHarness();
		vi.clearAllMocks();
		onRevertCommit = vi.fn<(commit: GitHistoryRevertTarget) => void>();
		vi.mocked(getGitHistoryCommits).mockResolvedValue({
			project: '/project',
			ref: 'HEAD',
			commits: [commitListItem()],
			nextOffset: null,
		});
		vi.mocked(getGitCommitSnapshot).mockResolvedValue(snapshot());
		vi.mocked(getGitCommitFileBodies).mockImplementation(
			async (_project, _documentId, _commit, files) => bodiesForPaths(files),
		);
	});

	afterEach(() => {
		restoreResizeObserver();
	});

	it('navigates from commit list to details and back', async () => {
		render(GitHistoryView, {
			props: {
				projectPath: '/project',
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
	});

	it('uses files and diff tabs on mobile commit details', async () => {
		const { container } = render(GitHistoryView, {
			props: {
				projectPath: '/project',
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
		const details = container.querySelector<HTMLElement>('[data-git-history-details]');
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
		expect(screen.getByRole('button', { name: /Files/ })).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Diff' })).toBeTruthy();
		expect(screen.getByPlaceholderText('Filter files')).toBeTruthy();

		await waitFor(() => {
			expect(getGitCommitFileBodies).toHaveBeenCalled();
		});
		if (!filesPane) return;
		await fireEvent.click(within(filesPane).getByRole('button', { name: /a.ts/ }));

		await screen.findAllByText('+added line');
		expect(filesPane.getAttribute('aria-hidden')).toBe('true');
		expect(diffPane?.getAttribute('aria-hidden')).toBe('false');
		expect(container.querySelector('[data-git-virtual-diff-root]')).toBe(diffRoot);
	});

	it('switches a narrow desktop container without remounting the diff', async () => {
		const { container } = render(GitHistoryView, {
			props: {
				projectPath: '/project',
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

		const details = container.querySelector<HTMLElement>('[data-git-history-details]');
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
	});

	it('loads a selected file outside the initial body candidates in a narrow layout', async () => {
		const { container } = render(GitHistoryView, {
			props: {
				projectPath: '/project',
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

		const details = container.querySelector<HTMLElement>('[data-git-history-details]');
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
			.mock.calls.some(([, , , paths]) => paths.includes('later.ts'));
		expect(requestedLaterBeforeSelection).toBe(false);

		await fireEvent.click(within(filesPane).getByRole('button', { name: /later\.ts/ }));

		await waitFor(() => {
			const requestedLaterFile = vi
				.mocked(getGitCommitFileBodies)
				.mock.calls.some(([, , , paths]) => paths.includes('later.ts'));
			expect(requestedLaterFile).toBe(true);
		});
		ResizeObserverHarness.emit(diffRoot, 480, 720);
		expect(
			container.querySelector('[data-git-history-diff-pane]')?.getAttribute('aria-hidden'),
		).toBe('false');
		expect(await screen.findByText('+later line')).toBeTruthy();
	});

	it('reports list row revert requests without opening the commit', async () => {
		render(GitHistoryView, {
			props: {
				projectPath: '/project',
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
});
