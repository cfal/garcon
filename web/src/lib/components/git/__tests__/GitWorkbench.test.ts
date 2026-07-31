import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitWorkbenchStore } from '$lib/git/workbench/git-workbench.svelte.js';
import type { GitWorkbenchTarget } from '$lib/git/workbench/git-workbench-types.js';
import { emptyGitVirtualReviewRowSource } from '$lib/git/review/git-virtual-review-row-source.js';
import GitWorkbenchTestHost from './GitWorkbenchTestHost.svelte';
import {
	installResizeObserverHarness,
	ResizeObserverHarness,
} from '$lib/components/shared/__tests__/resize-observer-harness';
import { LOCAL_STORAGE_KEYS } from '$lib/utils/local-persistence';

vi.mock('$lib/components/workspace/WorkspaceFullscreenButton.svelte', async () => ({
	default: (await import('./WorkspaceFullscreenButtonStub.svelte')).default,
}));

function makeTarget(): GitWorkbenchTarget {
	return {
		projectPath: '/project',
		repoRoot: '/project',
		worktreePath: '/project',
		label: 'project',
		source: 'chat-project',
	};
}

function makeWorkbenchStub(target: GitWorkbenchTarget | null = null): GitWorkbenchStore {
	const files = {
		hasCommits: true,
		isLoadingTree: false,
		treePaneWidthPx: 300,
		collapsedDirs: new Set<string>(),
		treeSearchQuery: '',
		totalChangedFiles: 0,
		visibleChangedFiles: 0,
		filteredTree: [],
		selectedFile: null,
		hideGenerated: false,
		hideOtherTabFiles: false,
		hideOtherTabFilesLabel: 'Hide staged',
		activeTab: 'unstaged',
		stagedFiles: [],
		stagedFileNodes: [],
		setTreePaneWidth: vi.fn(),
		previewTreePaneWidth: vi.fn(),
		toggleDirCollapsed: vi.fn(),
		firstVisibleFileInDirectory: vi.fn(() => null),
		previousVisibleFile: vi.fn(() => null),
		nextVisibleFile: vi.fn(() => null),
		unstagedFileCount: () => 0,
		stagedFileCount: () => 0,
	};
	const review = {
		rowSource: emptyGitVirtualReviewRowSource(),
		scrollRequest: null,
		summary: null,
		fileBodies: {},
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
		commentComposer: {
			open: false,
			focusPending: false,
			filePath: '',
			side: 'after',
			line: 0,
			body: '',
			severity: 'note',
		},
		openCommentComposer: vi.fn(),
		markCommentComposerFocused: vi.fn(),
		setCommentBody: vi.fn(),
		setCommentSeverity: vi.fn(),
		appendComment: vi.fn(),
		closeCommentComposer: vi.fn(),
		commentFeedback: null,
		commentError: null,
	};
	const porcelain = {
		inspectorView: 'none',
		setInspectorView: vi.fn(),
		cancelActiveLoad: vi.fn(),
	};

	return {
		target,
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
		isExternallyStale: false,
		pendingDiscardFile: null,
		setTarget: vi.fn().mockResolvedValue(undefined),
		selectFile: vi.fn().mockResolvedValue(undefined),
		selectPreviousFile: vi.fn().mockResolvedValue(undefined),
		selectNextFile: vi.fn().mockResolvedValue(undefined),
		setActiveTab: vi.fn(),
		setHideGenerated: vi.fn(),
		setHideOtherTabFiles: vi.fn(),
		handleReviewBodyDemand: vi.fn(),
		dismissError: vi.fn(),
	} as unknown as GitWorkbenchStore;
}

describe('GitWorkbench', () => {
	let restoreResizeObserver: () => void;

	beforeEach(() => {
		restoreResizeObserver = installResizeObserverHarness();
		localStorage.removeItem(LOCAL_STORAGE_KEYS.gitDiffDocumentFileTreeVisible);
	});

	afterEach(() => {
		restoreResizeObserver();
		localStorage.removeItem(LOCAL_STORAGE_KEYS.gitDiffDocumentFileTreeVisible);
	});

	it('shows an initial loading state before the store adopts the rendered target', () => {
		render(GitWorkbenchTestHost, {
			props: {
				target: makeTarget(),
				presentation: 'main',
				wb: makeWorkbenchStub(),
				diffFontSize: 12,
			},
		});

		expect(screen.getByText('Loading Git changes...')).toBeTruthy();
		expect(screen.queryByText('No changed files')).toBeNull();
	});

	it('uses tabs whenever the host is too narrow for the side-by-side layout', async () => {
		const target = makeTarget();
		const { container } = render(GitWorkbenchTestHost, {
			props: {
				target,
				presentation: 'main',
				wb: makeWorkbenchStub(target),
				diffFontSize: 12,
			},
		});
		const workbench = container.querySelector('[data-git-workbench]');
		expect(workbench).toBeTruthy();
		if (!workbench) return;

		ResizeObserverHarness.emit(workbench, 1_100);
		await waitFor(() => expect(workbench.getAttribute('data-git-layout')).toBe('wide'));
		expect(container.querySelector('[data-git-tree-resizer]')).toBeTruthy();
		const fileTreeToggle = screen.getByRole('button', { name: 'Hide file tree' });
		expect(
			fileTreeToggle.nextElementSibling?.getAttribute('data-workspace-fullscreen-toggle'),
		).toBe('main');
		const diffSurface = container.querySelector('[data-git-virtual-diff-root]');
		expect(diffSurface).toBeTruthy();

		ResizeObserverHarness.emit(workbench, 700);
		await waitFor(() => expect(workbench.getAttribute('data-git-layout')).toBe('narrow'));
		expect(container.querySelector('[data-git-tree-resizer]')).toBeNull();
		expect(container.querySelector('[data-workspace-fullscreen-toggle]')).toBeNull();
		expect(container.querySelector('[data-git-virtual-diff-root]')).toBe(diffSurface);
		expect(container.querySelector('[data-git-segmented-navigation]')).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Files' })).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Diff' })).toBeTruthy();

		ResizeObserverHarness.emit(workbench, 480);
		await waitFor(() => expect(workbench.getAttribute('data-git-layout')).toBe('narrow'));
		expect(container.querySelector('[data-git-segmented-navigation]')).toBeTruthy();
		expect(container.querySelector('[data-git-virtual-diff-root]')).toBe(diffSurface);

		const filesPane = container.querySelector('[data-git-files-pane]');
		const diffPane = container.querySelector('[data-git-diff-pane]');
		expect(filesPane?.getAttribute('aria-hidden')).toBe('false');
		expect(diffPane?.getAttribute('aria-hidden')).toBe('true');

		await fireEvent.click(screen.getByRole('button', { name: 'Diff' }));
		expect(filesPane?.getAttribute('aria-hidden')).toBe('true');
		expect(diffPane?.getAttribute('aria-hidden')).toBe('false');
		expect(container.querySelector('[data-git-virtual-diff-root]')).toBe(diffSurface);

		await fireEvent.click(screen.getByRole('button', { name: 'Files' }));
		expect(filesPane?.getAttribute('aria-hidden')).toBe('false');
		expect(diffPane?.getAttribute('aria-hidden')).toBe('true');
		expect(container.querySelector('[data-git-virtual-diff-root]')).toBe(diffSurface);
	});

	it('hides and restores the file tree in the wide layout', async () => {
		const target = makeTarget();
		const { container } = render(GitWorkbenchTestHost, {
			props: {
				target,
				presentation: 'main',
				wb: makeWorkbenchStub(target),
				diffFontSize: 12,
			},
		});
		const workbench = container.querySelector<HTMLElement>('[data-git-workbench]');
		expect(workbench).toBeTruthy();
		if (!workbench) return;

		ResizeObserverHarness.emit(workbench, 1_100);
		await waitFor(() => expect(workbench.dataset.gitLayout).toBe('wide'));

		const panes = container.querySelector<HTMLElement>('[data-git-wide-layout]');
		const filesPane = container.querySelector<HTMLElement>('[data-git-files-pane]');
		expect(panes?.style.gridTemplateColumns).toContain('300px 6px');
		expect(container.querySelector('[data-git-tree-resizer]')).toBeTruthy();

		await fireEvent.click(screen.getByRole('button', { name: 'Hide file tree' }));

		expect(filesPane?.getAttribute('aria-hidden')).toBe('true');
		expect(filesPane?.hasAttribute('inert')).toBe(true);
		expect(panes?.style.gridTemplateColumns).toBe('0px minmax(0,1fr)');
		expect(container.querySelector('[data-git-tree-resizer]')).toBeNull();
		expect(localStorage.getItem(LOCAL_STORAGE_KEYS.gitDiffDocumentFileTreeVisible)).toBe('false');

		await fireEvent.click(screen.getByRole('button', { name: 'Show file tree' }));

		expect(filesPane?.getAttribute('aria-hidden')).toBe('false');
		expect(panes?.style.gridTemplateColumns).toContain('300px 6px');
		expect(container.querySelector('[data-git-tree-resizer]')).toBeTruthy();
	});

	it('targets the rendered desktop host and omits fullscreen on mobile', async () => {
		const target = makeTarget();
		const sidebar = render(GitWorkbenchTestHost, {
			props: {
				target,
				presentation: 'sidebar',
				wb: makeWorkbenchStub(target),
				diffFontSize: 12,
			},
		});
		const sidebarWorkbench = sidebar.container.querySelector<HTMLElement>('[data-git-workbench]');
		expect(sidebarWorkbench).toBeTruthy();
		if (!sidebarWorkbench) return;
		ResizeObserverHarness.emit(sidebarWorkbench, 1_100);
		await waitFor(() => expect(sidebarWorkbench.dataset.gitLayout).toBe('wide'));
		expect(
			screen
				.getByRole('button', { name: 'Hide file tree' })
				.nextElementSibling?.getAttribute('data-workspace-fullscreen-toggle'),
		).toBe('sidebar');

		sidebar.unmount();
		const mobile = render(GitWorkbenchTestHost, {
			props: {
				target,
				presentation: 'mobile',
				wb: makeWorkbenchStub(target),
				diffFontSize: 12,
			},
		});
		const mobileWorkbench = mobile.container.querySelector<HTMLElement>('[data-git-workbench]');
		expect(mobileWorkbench).toBeTruthy();
		if (!mobileWorkbench) return;
		ResizeObserverHarness.emit(mobileWorkbench, 1_100);
		await waitFor(() => expect(mobileWorkbench.dataset.gitLayout).toBe('narrow'));
		expect(mobile.container.querySelector('[data-workspace-fullscreen-toggle]')).toBeNull();
	});
});
