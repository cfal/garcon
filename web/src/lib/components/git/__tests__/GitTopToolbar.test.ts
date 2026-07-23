import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import GitTopToolbar from '../GitTopToolbar.svelte';
import type { GitRemoteStatus, GitTargetCandidate } from '$lib/api/git';
import * as m from '$lib/paraglide/messages.js';

function makeRemoteStatus(branch: string): GitRemoteStatus {
	return {
		hasRemote: true,
		hasUpstream: true,
		branch,
		remoteName: 'origin',
		remoteBranch: `origin/${branch}`,
		ahead: 0,
		behind: 0,
		isUpToDate: true,
	};
}

function renderToolbar(overrides: Record<string, unknown> = {}) {
	return render(GitTopToolbar, {
		isMobile: false,
		activeView: 'changes',
		currentBranch: 'main',
		refs: [
			{ name: 'main', ref: 'refs/heads/main', kind: 'local-branch', isCurrent: true },
			{ name: 'feature/search', ref: 'refs/heads/feature/search', kind: 'local-branch' },
			{ name: 'bugfix/login', ref: 'refs/heads/bugfix/login', kind: 'local-branch' },
		],
		remoteStatus: null,
		targets: [],
		activeWorktreePath: null,
		isLoadingTargets: false,
		showBranchDropdown: false,
		isLoading: false,
		isPushing: false,
		reviewCount: 0,
		isCommitting: false,
		canPush: false,
		diffMode: 'unified',
		contextLines: 5,
		diffFontSize: '12',
		onToggleBranchDropdown: vi.fn(),
		onCloseBranchDropdown: vi.fn(),
		onShowNewBranchModal: vi.fn(),
		onSwitchBranch: vi.fn(),
		onViewCommits: vi.fn(),
		onViewChanges: vi.fn(),
		onOpenReview: vi.fn(),
		onOpenComparison: vi.fn(),
		onCommit: vi.fn(),
		onPush: vi.fn(),
		onSetDiffMode: vi.fn(),
		onSetContextLines: vi.fn(),
		onSetDiffFontSize: vi.fn(),
		onRefresh: vi.fn(),
		...overrides,
	});
}

function installToolbarMeasurement(initialRailWidth: number) {
	let railWidth = initialRailWidth;
	const actionWidths: Record<string, number> = {
		history: 64,
		compare: 72,
		review: 58,
		commit: 72,
		push: 44,
		refresh: 36,
		changes: 68,
	};
	const observers: Array<{
		callback: ResizeObserverCallback;
		elements: Set<Element>;
	}> = [];
	const previousResizeObserver = globalThis.ResizeObserver;

	function elementWidth(element: Element): number {
		if ((element as HTMLElement).hasAttribute('data-git-toolbar-action-rail')) return railWidth;
		const action = (element as HTMLElement).dataset.gitToolbarMeasureAction;
		if (action) return actionWidths[action] ?? 0;
		if ((element as HTMLElement).hasAttribute('data-git-toolbar-measure-more')) return 36;
		if ((element as HTMLElement).hasAttribute('data-git-toolbar-measure-settings')) return 32;
		return 0;
	}

	const offsetWidthSpy = vi
		.spyOn(HTMLElement.prototype, 'offsetWidth', 'get')
		.mockImplementation(function offsetWidth(this: HTMLElement) {
			return elementWidth(this);
		});
	const clientWidthSpy = vi
		.spyOn(HTMLElement.prototype, 'clientWidth', 'get')
		.mockImplementation(function clientWidth(this: HTMLElement) {
			return elementWidth(this);
		});

	class TestResizeObserver implements ResizeObserver {
		private callback: ResizeObserverCallback;
		private elements = new Set<Element>();

		constructor(callback: ResizeObserverCallback) {
			this.callback = callback;
			observers.push({ callback: this.callback, elements: this.elements });
		}

		observe(target: Element): void {
			this.elements.add(target);
			this.callback(
				[
					{
						target,
						contentRect: { width: elementWidth(target) } as DOMRectReadOnly,
					} as ResizeObserverEntry,
				],
				this,
			);
		}

		unobserve(target: Element): void {
			this.elements.delete(target);
		}

		disconnect(): void {
			this.elements.clear();
		}
	}

	globalThis.ResizeObserver = TestResizeObserver;

	return {
		setRailWidth(width: number): void {
			railWidth = width;
			for (const observer of observers) {
				const entries = Array.from(observer.elements).map(
					(target) =>
						({
							target,
							contentRect: { width: elementWidth(target) } as DOMRectReadOnly,
						}) as ResizeObserverEntry,
				);
				observer.callback(entries, {} as ResizeObserver);
			}
		},
		restore(): void {
			offsetWidthSpy.mockRestore();
			clientWidthSpy.mockRestore();
			if (previousResizeObserver) globalThis.ResizeObserver = previousResizeObserver;
			else
				delete (globalThis as unknown as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
		},
	};
}

describe('GitTopToolbar', () => {
	afterEach(() => {
		cleanup();
	});

	it('uses the remote branch as the branch button label when current branch is not loaded yet', () => {
		renderToolbar({
			currentBranch: '',
			remoteStatus: makeRemoteStatus('main'),
		});

		expect(screen.getByRole('button', { name: /current ref main/i })).toBeTruthy();
		expect(screen.getByText('main')).toBeTruthy();
	});

	it('filters refs in the combobox and switches to the selected branch', async () => {
		const onSwitchBranch = vi.fn();
		renderToolbar({
			showBranchDropdown: true,
			onSwitchBranch,
		});

		const search = screen.getByRole('combobox', { name: 'Find a ref' });
		await fireEvent.input(search, { target: { value: 'feature' } });

		const branch = screen.getByRole('option', { name: /feature\/search/ });
		expect(branch).toBeTruthy();
		expect(screen.queryByRole('option', { name: /main/ })).toBeNull();

		await fireEvent.click(branch);

		expect(screen.getByRole('heading', { name: 'Switch to branch feature/search?' })).toBeTruthy();
		expect(onSwitchBranch).not.toHaveBeenCalled();

		await fireEvent.click(screen.getByRole('button', { name: 'Switch branch' }));

		expect(onSwitchBranch).toHaveBeenCalledWith('refs/heads/feature/search', 'local-branch');
	});

	it('places the worktree trigger before the branch control with a front-ellipsized path', async () => {
		const onOpenWorktrees = vi.fn();
		const worktreePath = '/Users/alice/dev/company/product/source/garcon';
		const targets: GitTargetCandidate[] = [
			{
				projectPath: worktreePath,
				repoRoot: '/Users/alice/dev/company/product/source/garcon',
				worktreePath,
				label: 'garcon',
				branch: 'main',
				source: 'worktree',
				isCurrent: true,
				isMissing: false,
			},
		];

		renderToolbar({
			targets,
			activeWorktreePath: worktreePath,
			onOpenWorktrees,
		});

		const worktreeButton = screen.getByRole('button', {
			name: `Open Git target selector, current folder ${worktreePath}`,
		});
		const branchButton = screen.getByRole('button', { name: /current ref main/i });
		const buttons = screen.getAllByRole('button');

		expect(buttons.indexOf(worktreeButton)).toBeLessThan(buttons.indexOf(branchButton));
		expect(worktreeButton.textContent).toContain('/.../company/product/source/garcon');
		expect(worktreeButton.textContent).not.toBe('garcon');

		await fireEvent.click(worktreeButton);

		expect(onOpenWorktrees).toHaveBeenCalledOnce();
	});

	it('opens Commit when the workbench has no staged files', async () => {
		const onCommit = vi.fn();
		renderToolbar({ onCommit });

		const commitButton = screen.getByRole('button', { name: m.git_changes_commit() });
		expect((commitButton as HTMLButtonElement).disabled).toBe(false);
		await fireEvent.click(commitButton);

		expect(onCommit).toHaveBeenCalledOnce();
	});

	it('opens the shared comparison workflow from Changes', async () => {
		const onOpenComparison = vi.fn();
		renderToolbar({ onOpenComparison });

		await fireEvent.click(screen.getByRole('button', { name: 'Compare revisions' }));

		expect(onOpenComparison).toHaveBeenCalledOnce();
	});

	it('keeps actions inline when the action rail has enough space', async () => {
		const measurement = installToolbarMeasurement(420);
		try {
			renderToolbar({ isMobile: true, canPush: true });

			await waitFor(() => {
				expect(screen.queryByRole('button', { name: 'More Git actions' })).toBeNull();
			});

			expect(screen.getByRole('button', { name: m.git_view_commit_history() })).toBeTruthy();
			expect(screen.getByRole('button', { name: m.git_header_refresh() })).toBeTruthy();
		} finally {
			measurement.restore();
		}
	});

	it('keeps Compare visible before History when one Changes action must overflow', async () => {
		const measurement = installToolbarMeasurement(300);
		try {
			renderToolbar({ isMobile: true, canPush: true });

			await waitFor(() => {
				expect(screen.getByRole('button', { name: 'More Git actions' })).toBeTruthy();
			});

			expect(screen.getByRole('button', { name: m.git_compare_title() })).toBeTruthy();
			expect(screen.queryByRole('button', { name: m.git_view_commit_history() })).toBeNull();
		} finally {
			measurement.restore();
		}
	});

	it('moves lower priority actions into More when the action rail is narrow', async () => {
		const measurement = installToolbarMeasurement(160);
		try {
			renderToolbar({ isMobile: true, canPush: true });

			await waitFor(() => {
				expect(screen.getByRole('button', { name: 'More Git actions' })).toBeTruthy();
			});

			expect(screen.getByRole('button', { name: m.git_changes_commit() })).toBeTruthy();
			expect(screen.queryByRole('button', { name: m.git_view_commit_history() })).toBeNull();

			await fireEvent.click(screen.getByRole('button', { name: 'More Git actions' }));

			expect(screen.getByRole('menuitem', { name: /History/ })).toBeTruthy();
			expect(screen.getByRole('menuitem', { name: /Push/ })).toBeTruthy();
		} finally {
			measurement.restore();
		}
	});
});
