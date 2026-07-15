import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
	getGitCommitFileBodies,
	getGitCommitSnapshot,
	getGitHistoryCommits,
} from '$lib/api/git.js';
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
		files: [
			{
				path: 'a.ts',
				status: 'modified' as const,
				rawStatus: 'M',
				category: 'normal' as const,
				additions: 1,
				deletions: 0,
				estimatedRows: 2,
				bodyState: 'unloaded' as const,
				bodyFingerprint: 'fp-a',
				isGenerated: false,
				isBinary: false,
				isTooLarge: false,
			},
		],
		limits,
		firstBodyCandidates: ['a.ts'],
	};
}

function body() {
	return {
		documentId: 'doc-abc',
		files: {
			'a.ts': {
				path: 'a.ts',
				bodyFingerprint: 'fp-a',
				bodyState: 'loaded' as const,
				category: 'normal' as const,
				isBinary: false,
				isTooLarge: false,
				rows: [
					{
						key: 'hunk',
						kind: 'hunk' as const,
						text: '@@ -1 +1 @@',
						beforeLine: null,
						afterLine: null,
						hunkId: 'h0',
						hunkIndex: 0,
						diffLineIndex: -1,
					},
					{
						key: 'add',
						kind: 'add' as const,
						text: 'added line',
						beforeLine: null,
						afterLine: 1,
						hunkId: 'h0',
						hunkIndex: 0,
						diffLineIndex: 0,
					},
				],
				hunks: [],
			},
		},
		errors: {},
	};
}

describe('GitHistoryView', () => {
	let onRevertCommit: ReturnType<typeof vi.fn<(commit: GitHistoryRevertTarget) => void>>;

	beforeEach(() => {
		vi.clearAllMocks();
		onRevertCommit = vi.fn<(commit: GitHistoryRevertTarget) => void>();
		vi.mocked(getGitHistoryCommits).mockResolvedValue({
			project: '/project',
			ref: 'HEAD',
			commits: [commitListItem()],
			nextOffset: null,
		});
		vi.mocked(getGitCommitSnapshot).mockResolvedValue(snapshot());
		vi.mocked(getGitCommitFileBodies).mockResolvedValue(body());
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
		render(GitHistoryView, {
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
		expect(screen.getByRole('button', { name: /Files/ })).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Diff' })).toBeTruthy();
		expect(screen.getByPlaceholderText('Filter files')).toBeTruthy();
		expect(screen.queryByText('+added line')).toBeNull();

		await waitFor(() => {
			expect(getGitCommitFileBodies).toHaveBeenCalled();
		});
		await fireEvent.click(screen.getByRole('button', { name: /a.ts/ }));

		await screen.findByText('+added line');
		expect(screen.queryByPlaceholderText('Filter files')).toBeNull();
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
