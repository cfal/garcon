import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitComparisonController } from '$lib/git/review/git-comparison.svelte.js';
import { LOCAL_STORAGE_KEYS } from '$lib/utils/local-persistence';
import type { GitComparisonSnapshotReady } from '$lib/api/git-comparison.js';
import GitComparisonScreen from '../GitComparisonScreen.svelte';
import {
	installResizeObserverHarness,
	ResizeObserverHarness,
} from '$lib/components/shared/__tests__/resize-observer-harness.js';

vi.mock('$lib/components/workspace/WorkspaceFullscreenButton.svelte', async () => ({
	default: (await import('./WorkspaceFullscreenButtonStub.svelte')).default,
}));

function renderScreen(comparison: GitComparisonController, isLoading: boolean): void {
	render(GitComparisonScreen, {
		comparison,
		isLoading,
		presentation: 'main',
		fontSize: 12,
		onEdit: vi.fn(),
		onRefresh: vi.fn(),
		onOpenChat: vi.fn(),
	});
}

describe('GitComparisonScreen', () => {
	let restoreResizeObserver: () => void;

	beforeEach(() => {
		restoreResizeObserver = installResizeObserverHarness();
		localStorage.removeItem(LOCAL_STORAGE_KEYS.gitTreePaneWidthPx);
		localStorage.removeItem(LOCAL_STORAGE_KEYS.gitDiffDocumentFileTreeVisible);
	});

	afterEach(() => {
		cleanup();
		restoreResizeObserver();
		localStorage.removeItem(LOCAL_STORAGE_KEYS.gitTreePaneWidthPx);
		localStorage.removeItem(LOCAL_STORAGE_KEYS.gitDiffDocumentFileTreeVisible);
	});

	it('shows initialization as loading instead of a comparison error', () => {
		renderScreen(new GitComparisonController(), true);

		expect(screen.getByText('Loading comparison')).toBeTruthy();
		expect(screen.queryByText('Comparison could not be loaded.')).toBeNull();
	});

	it('preserves a real comparison failure after initialization', () => {
		const comparison = new GitComparisonController();
		comparison.error = 'Revision HEAD was not found.';

		renderScreen(comparison, false);

		expect(screen.getByText('Revision HEAD was not found.')).toBeTruthy();
		expect(screen.queryByText('Loading comparison')).toBeNull();
	});

	it('offers local back navigation without exposing the standalone Edit action', async () => {
		const comparison = new GitComparisonController();
		comparison.error = 'Revision older was not found.';
		const onBack = vi.fn();

		render(GitComparisonScreen, {
			comparison,
			isLoading: false,
			presentation: 'main',
			fontSize: 12,
			onBack,
			onRefresh: vi.fn(),
			onOpenChat: vi.fn(),
		});

		expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
		await fireEvent.click(screen.getByRole('button', { name: 'Back to commit selection' }));
		expect(onBack).toHaveBeenCalledOnce();
	});

	it.each(['main', 'sidebar'] as const)(
		'places the %s fullscreen control after the wide file-tree toggle',
		async (presentation) => {
			const comparison = new GitComparisonController();
			comparison.snapshot = readySnapshot();
			const { container } = render(GitComparisonScreen, {
				comparison,
				isLoading: false,
				presentation,
				fontSize: 12,
				onRefresh: vi.fn(),
				onOpenChat: vi.fn(),
			});
			const document = container.querySelector<HTMLElement>('[data-git-diff-document]');
			expect(document).toBeTruthy();
			if (!document) return;
			ResizeObserverHarness.emit(document, 1_100);
			await vi.waitFor(() => expect(document.dataset.gitHistoryLayout).toBe('wide'));

			expect(
				screen
					.getByRole('button', { name: 'Hide file tree' })
					.nextElementSibling?.getAttribute('data-workspace-fullscreen-toggle'),
			).toBe(presentation);
		},
	);

	it('collapses comparison panes into segmented navigation below the wide breakpoint', async () => {
		const comparison = new GitComparisonController();
		comparison.snapshot = readySnapshot();
		const { container } = render(GitComparisonScreen, {
			comparison,
			isLoading: false,
			presentation: 'main',
			fontSize: 12,
			onRefresh: vi.fn(),
			onOpenChat: vi.fn(),
		});
		const document = container.querySelector<HTMLElement>('[data-git-diff-document]');
		expect(document).toBeTruthy();
		if (!document) return;

		ResizeObserverHarness.emit(document, 560);
		await vi.waitFor(() => expect(document.dataset.gitHistoryLayout).toBe('narrow'));
		expect(container.querySelector('[data-git-history-segmented-navigation]')).toBeTruthy();
		expect(screen.queryByRole('button', { name: 'Hide file tree' })).toBeNull();
		expect(container.querySelector('[data-git-tree-resizer]')).toBeNull();

		ResizeObserverHarness.emit(document, 840);
		await vi.waitFor(() => expect(document.dataset.gitHistoryLayout).toBe('wide'));
		expect(container.querySelector('[data-git-history-segmented-navigation]')).toBeNull();
		expect(screen.getByRole('button', { name: 'Hide file tree' })).toBeTruthy();
		expect(container.querySelector('[data-git-tree-resizer]')).toBeTruthy();
	});

	it('omits the inline fullscreen control from mobile comparison', () => {
		const comparison = new GitComparisonController();
		comparison.snapshot = readySnapshot();
		const { container } = render(GitComparisonScreen, {
			comparison,
			isLoading: false,
			presentation: 'mobile',
			fontSize: 12,
			onRefresh: vi.fn(),
			onOpenChat: vi.fn(),
		});

		expect(container.querySelector('[data-workspace-fullscreen-toggle]')).toBeNull();
	});
});

function readySnapshot(): GitComparisonSnapshotReady {
	return {
		status: 'ready',
		project: '/project',
		repoRoot: '/project',
		documentId: 'comparison-document',
		mode: 'direct',
		from: {
			kind: 'revision',
			requestedRevision: 'HEAD~1',
			label: 'HEAD~1',
			hash: 'a'.repeat(40),
			shortHash: 'aaaaaaa',
		},
		to: {
			kind: 'working-tree',
			label: 'Working Tree',
			branch: 'main',
			headHash: 'b'.repeat(40),
			fingerprint: 'worktree-fingerprint',
			shortFingerprint: 'worktree',
		},
		effectiveFromHash: 'a'.repeat(40),
		files: [],
		limits: {
			maxSummaryFiles: 1000,
			maxBodyBatchFiles: 24,
			maxLoadedRows: 10_000,
			maxLoadedPatchBytes: 1024 * 1024,
			maxFileRows: 10_000,
			maxFilePatchBytes: 1024 * 1024,
			maxLineBytes: 20_000,
			maxContextLines: 50,
			bodyConcurrency: 4,
		},
		firstBodyCandidates: [],
	};
}
