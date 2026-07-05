import { render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import type { GitWorkbenchStore, GitWorkbenchTarget } from '$lib/stores/git-workbench.svelte';
import GitWorkbench from '../GitWorkbench.svelte';

function makeTarget(): GitWorkbenchTarget {
	return {
		projectPath: '/project',
		repoRoot: '/project',
		worktreePath: '/project',
		label: 'project',
		source: 'chat-project',
	};
}

function makeWorkbenchStub(): GitWorkbenchStore {
	const files = {
		hasCommits: true,
		isLoadingTree: false,
		treePaneWidthPx: 300,
		collapsedDirs: new Set<string>(),
		treeSearchQuery: '',
		totalChangedFiles: 0,
		stagedFiles: [],
		stagedFileNodes: [],
		setTreePaneWidth: vi.fn(),
		toggleDirCollapsed: vi.fn(),
		unstagedFileCount: () => 0,
		stagedFileCount: () => 0,
	};
	const review = {
		virtualRows: [],
		fileRowIndex: new Map<string, number>(),
		scrollRequest: null,
	};
	const selection = {
		selectedLineKeys: new Set<string>(),
		hasSelection: false,
		toggleLineSelection: vi.fn(),
		selectLineRange: vi.fn(),
		clearSelection: vi.fn(),
	};
	const staging = {
		pendingDiscardFile: null,
		hasPendingOperations: false,
		stageSelectedLines: vi.fn(),
		unstageSelectedLines: vi.fn(),
		stageFile: vi.fn(),
		unstageFile: vi.fn(),
		stageDirectory: vi.fn(),
		unstageDirectory: vi.fn(),
		stageHunk: vi.fn(),
		unstageHunk: vi.fn(),
		stageLine: vi.fn(),
		unstageLine: vi.fn(),
		requestDiscard: vi.fn(),
		confirmDiscard: vi.fn(),
		cancelDiscard: vi.fn(),
		isFilePending: () => false,
		isDirectoryPending: () => false,
	};
	const commit = {
		isCreatingInitialCommit: false,
	};
	const drafts = {
		reviewModalOpen: false,
		reviewComments: [],
		reviewSummary: '',
		commentsByFile: {},
		commentComposer: {
			open: false,
			filePath: '',
			side: 'after',
			line: 0,
			body: '',
			severity: 'note',
		},
		openCommentComposer: vi.fn(),
		finalizeReviewToAgent: vi.fn(),
		buildFinalizedReviewMessage: vi.fn(),
		updateDraftComment: vi.fn(),
		removeDraftComment: vi.fn(),
		commitCommentComposer: vi.fn(),
		closeCommentComposer: vi.fn(),
	};
	const porcelain = {
		inspectorView: 'none',
		setInspectorView: vi.fn(),
	};

	return {
		target: null,
		files,
		review,
		selection,
		staging,
		commit,
		drafts,
		porcelain,
		lastError: null,
		repositoryError: null,
		isInitialLoadPending: false,
		reviewModalOpen: false,
		reviewComments: [],
		reviewSummary: '',
		commentsByFile: {},
		commentComposer: {
			open: false,
			filePath: '',
			side: 'after',
			line: 0,
			body: '',
			severity: 'note',
		},
		pendingDiscardFile: null,
		setTarget: vi.fn().mockResolvedValue(undefined),
		dismissError: vi.fn(),
	} as unknown as GitWorkbenchStore;
}

describe('GitWorkbench', () => {
	it('shows an initial loading state before the store adopts the rendered target', () => {
		render(GitWorkbench, {
			props: {
				target: makeTarget(),
				isMobile: false,
				wb: makeWorkbenchStub(),
				diffFontSize: 12,
			},
		});

		expect(screen.getByText('Loading Git changes...')).toBeTruthy();
		expect(screen.queryByText('No changed files')).toBeNull();
	});
});
