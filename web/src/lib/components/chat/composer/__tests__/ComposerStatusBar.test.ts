import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'svelte';
import ComposerStatusBar from '../ComposerStatusBar.svelte';
import type { ComposerStatusBarBranchControls } from '../composer-status-bar-types.js';
import type { GitQuickSummaryReady } from '$lib/api/git.js';

const NAME_ASC = { key: 'name', direction: 'asc' } as const;
const ALL_ITEMS = { projectPath: true, gitBranch: true, commit: true, visible: true };

function refsFromNames(names: string[]) {
	return names.map((name) => ({
		name,
		ref: `refs/heads/${name}`,
		kind: 'local-branch' as const,
		updatedAt: null,
		isCurrent: name === 'main',
	}));
}

function summary(overrides: Partial<GitQuickSummaryReady> = {}): GitQuickSummaryReady {
	return {
		status: 'ready',
		project: '/project',
		branch: 'main',
		hasChanges: true,
		hasUntracked: true,
		diffStats: { additions: 3, deletions: 1 },
		...overrides,
	};
}

function renderBar(overrides: Partial<ComponentProps<typeof ComposerStatusBar>> = {}) {
	return render(ComposerStatusBar, {
		items: { ...ALL_ITEMS },
		projectPath: '/project',
		summary: summary(),
		isRefreshing: false,
		onCommit: vi.fn(),
		...overrides,
	});
}

function branchControls(
	overrides: Partial<ComposerStatusBarBranchControls> = {},
): ComposerStatusBarBranchControls {
	return {
		refs: refsFromNames(['main', 'feature/bar']),
		sort: NAME_ASC,
		isOpen: false,
		isLoading: false,
		onToggle: vi.fn(),
		onClose: vi.fn(),
		onCreateBranch: vi.fn(),
		onSwitchBranch: vi.fn(),
		onSortRefs: vi.fn(),
		...overrides,
	};
}

describe('ComposerStatusBar', () => {
	afterEach(() => {
		cleanup();
	});

	it.each(Array.from({ length: 8 }, (_, mask) => mask))(
		'renders only included items (%i)',
		(mask) => {
			const items = {
				projectPath: Boolean(mask & 1),
				gitBranch: Boolean(mask & 2),
				commit: Boolean(mask & 4),
				visible: mask !== 0,
			};
			renderBar({ items });
			expect(Boolean(screen.queryByRole('button', { name: 'Change project path: /project' }))).toBe(
				items.projectPath,
			);
			expect(Boolean(screen.queryByText('main'))).toBe(items.gitBranch);
			expect(Boolean(screen.queryByRole('button', { name: /^Commit/ }))).toBe(items.commit);
			expect(Boolean(screen.queryByRole('status'))).toBe(items.visible);
		},
	);

	it('does not announce a path-only bar as waiting for Git', () => {
		renderBar({
			items: { projectPath: true, gitBranch: false, commit: false, visible: true },
			projectPath: '/plain-folder',
			summary: null,
			isRefreshing: true,
		});
		expect(screen.getByRole('status').getAttribute('aria-busy')).toBe('false');
		expect(screen.queryByRole('button', { name: /^Commit/ })).toBeNull();
	});

	it.each([null, 'Summary unavailable'])(
		'keeps the project action available before a summary (%s)',
		async (lastError) => {
			const onProjectPath = vi.fn();
			renderBar({
				projectPath: '/workspace/clients/project-a',
				onProjectPath,
				summary: null,
				isRefreshing: !lastError,
				lastError,
			});
			const button = screen.getByRole('button', {
				name: 'Change project path: /workspace/clients/project-a',
			});
			expect(button.getAttribute('title')).toBe(button.getAttribute('aria-label'));
			expect(button.getAttribute('aria-haspopup')).toBe('dialog');
			await fireEvent.click(button);
			expect(onProjectPath).toHaveBeenCalledOnce();
		},
	);

	it.each([
		['/workspace/clients/project-a', '/project-a'],
		['/workspace', 'workspace'],
		['/', '/'],
		['C:\\Users\\demo\\project-a', '\\project-a'],
		['C:\\', 'C:\\'],
		['project-a', 'project-a'],
	])('preserves the full path and final directory for %s', (projectPath, basename) => {
		const { container } = renderBar({ projectPath });
		const label = container.querySelector('[data-composer-project-path-label]');
		expect(Array.from(label?.children ?? [], (child) => child.textContent).join('')).toBe(
			projectPath,
		);
		expect(label?.lastElementChild?.textContent).toBe(basename);
		expect(
			(
				screen.getByRole('button', {
					name: `Change project path: ${projectPath}`,
				}) as HTMLButtonElement
			).disabled,
		).toBe(true);
	});

	it('updates the path and action without remounting the button', async () => {
		const onProjectPath = vi.fn();
		const view = renderBar({
			projectPath: '/project-a',
			onProjectPath,
		});
		const button = screen.getByRole('button', { name: 'Change project path: /project-a' });
		const nextAction = vi.fn();
		await view.rerender({ projectPath: '/project-b', onProjectPath: nextAction });
		expect(screen.getByRole('button', { name: 'Change project path: /project-b' })).toBe(button);
		await fireEvent.click(button);
		expect(nextAction).toHaveBeenCalledOnce();
		expect(onProjectPath).not.toHaveBeenCalled();
	});

	it('keeps Commit available and right-aligned before the first summary', () => {
		const { container } = renderBar({ summary: null, isRefreshing: true });

		const bar = screen.getByRole('status');
		expect(bar.getAttribute('data-slot')).toBe('chat-git-status');
		expect(bar.getAttribute('aria-busy')).toBe('true');
		expect(bar.className).toContain('min-h-14');
		const commit = screen.getByRole('button', { name: /^Commit/ });
		expect((commit as HTMLButtonElement).disabled).toBe(false);
		expect(commit.parentElement?.className).toContain('ml-auto');
		expect(screen.queryByTestId('commit-file-summary')).toBeNull();
		expect(container.querySelector('.animate-spin')).toBeTruthy();
	});

	it('does not render a visible loading indicator while refreshing a ready summary', () => {
		const { container } = renderBar({ isRefreshing: true });

		expect(screen.getByText('main')).toBeTruthy();
		expect(screen.getByText('main').parentElement?.getAttribute('data-slot')).toBe('chat-git-branch');
		expect(screen.getByRole('status').getAttribute('aria-busy')).toBe('true');
		expect(container.querySelector('.animate-spin')).toBeNull();
		expect(screen.queryByText('Loading...')).toBeNull();
	});

	it('uses the dirty summary as the Commit label without separate counts', async () => {
		const onCommit = vi.fn();
		renderBar({ onCommit });

		expect(screen.getByText('main')).toBeTruthy();
		expect(screen.getByText('+3')).toBeTruthy();
		expect(within(screen.getByRole('button', { name: /^Commit/ })).getByText('/')).toBeTruthy();
		expect(screen.getByText('-1')).toBeTruthy();
		expect(screen.queryByTestId('commit-file-summary')).toBeNull();
		expect(screen.getByRole('button', { name: /^Commit/ }).textContent).toContain('+3');

		await fireEvent.click(screen.getByRole('button', { name: /Commit/ }));
		expect(onCommit).toHaveBeenCalledOnce();
	});

	it('keeps controls visible while disabling non-anchor announcements', () => {
		const { container } = renderBar({ announcementsEnabled: false });

		const bar = container.firstElementChild?.firstElementChild;
		expect(bar?.getAttribute('role')).toBeNull();
		expect(bar?.getAttribute('aria-live')).toBe('off');
		expect(screen.getByRole('button', { name: /Commit/ })).toBeTruthy();
	});

	it('skips zero-value summary items', () => {
		renderBar({
			summary: summary({
				hasChanges: true,
				hasUntracked: true,
				diffStats: { additions: 0, deletions: 0 },
			}),
		});

		expect(screen.getByText('New files')).toBeTruthy();
		expect(screen.queryByText('+0')).toBeNull();
		expect(screen.queryByText('-0')).toBeNull();
		expect(screen.queryByText('0 staged')).toBeNull();
		expect(screen.queryByText('•')).toBeNull();
	});

	it('renders a muted clean button that still opens Commit', () => {
		renderBar({
			summary: summary({
				hasChanges: false,
				hasUntracked: false,
				diffStats: { additions: 0, deletions: 0 },
			}),
		});

		const commit = screen.getByRole('button', { name: /^Commit/ });
		expect(commit.className).toContain('text-muted-foreground');
		expect((commit as HTMLButtonElement).disabled).toBe(false);
	});

	it('renders the shared branch selector when branch controls are provided', async () => {
		const onToggle = vi.fn();
		const onClose = vi.fn();
		const onCreateBranch = vi.fn();
		const onSwitchBranch = vi.fn();
		const onSearchRefs = vi.fn();
		const onSortRefs = vi.fn();

		renderBar({
			branchSelector: branchControls({
				refs: refsFromNames(['main', 'feature/bar', 'bugfix/login']),
				isOpen: true,
				onToggle,
				onClose,
				onCreateBranch,
				onSwitchBranch,
				onSearchRefs,
				onSortRefs,
			}),
		});

		const menuClass = document.querySelector('[data-slot="popover-content"]')?.className ?? '';
		expect(menuClass).toContain('w-[min(36rem,calc(100vw-2rem))]');

		const search = screen.getByRole('combobox', { name: 'Find a ref' });
		await fireEvent.input(search, { target: { value: 'feature' } });
		expect(screen.queryByText('Branches')).toBeNull();
		await fireEvent.click(screen.getByRole('button', { name: 'Sort by Updated, newest first' }));
		expect(onSortRefs).toHaveBeenCalledWith('updated', 'feature');
		await new Promise((resolve) => window.setTimeout(resolve, 180));
		expect(onSearchRefs).not.toHaveBeenCalled();

		await fireEvent.click(screen.getByRole('option', { name: /feature\/bar/ }));
		expect(onClose).toHaveBeenCalledOnce();
		expect(screen.getByRole('heading', { name: 'Switch to branch feature/bar?' })).toBeTruthy();
		expect(onSwitchBranch).not.toHaveBeenCalled();

		await fireEvent.click(screen.getByRole('button', { name: 'Switch branch' }));
		expect(onSwitchBranch).toHaveBeenCalledWith('refs/heads/feature/bar', 'local-branch');

		await fireEvent.click(screen.getByRole('button', { name: 'Create new branch' }));
		expect(onCreateBranch).toHaveBeenCalledOnce();
		expect(onClose).toHaveBeenCalledTimes(2);
	});

	it('opens the shared branch selector from the trigger', async () => {
		const onToggle = vi.fn();
		renderBar({ branchSelector: branchControls({ onToggle }) });

		await fireEvent.click(screen.getByRole('button', { name: /current ref main/i }));

		expect(onToggle).toHaveBeenCalledOnce();
	});

	it('expands the branch control on wide screens without wrapping on narrow screens', () => {
		const longBranch = 'feature/a-long-current-branch-name';
		renderBar({
			summary: summary({ branch: longBranch }),
			branchSelector: branchControls({ refs: refsFromNames([longBranch]) }),
		});

		const trigger = screen.getByRole('button', {
			name: new RegExp(`current ref ${longBranch}`, 'i'),
		});
		const label = within(trigger).getByText(longBranch);
		expect(trigger.className).toContain('max-w-44');
		expect(trigger.className).toContain('sm:max-w-80');
		expect(label.className).toContain('max-w-32');
		expect(label.className).toContain('sm:max-w-64');
		expect(label.className).toContain('truncate');
	});

	it('widens the switch confirmation dialog while preserving narrow-screen truncation', async () => {
		const longBranch =
			'feature/some-extremely-long-branch-name-that-should-never-wrap-the-confirmation-dialog';
		renderBar({
			branchSelector: branchControls({
				refs: refsFromNames(['main', longBranch]),
				isOpen: true,
			}),
		});

		await fireEvent.click(screen.getByRole('option', { name: new RegExp(longBranch) }));

		const heading = screen.getByRole('heading', {
			name: `Switch to branch ${longBranch}?`,
		});
		const branchText = within(heading).getByText(longBranch);
		const dialogClass = heading.closest('[data-slot="dialog-content"]')?.className ?? '';
		const headerClass = heading.closest('[data-slot="dialog-header"]')?.className ?? '';
		expect(dialogClass).toContain('w-[calc(100%-2rem)]');
		expect(dialogClass).toContain('sm:max-w-2xl');
		expect(headerClass).toContain('min-w-0');
		expect(headerClass).toContain('max-w-full');
		expect(heading.className).toContain('max-w-full');
		expect(branchText.className).toContain('truncate');
	});

	it('does not auto-focus the branch search input on mobile', async () => {
		renderBar({
			isMobile: true,
			branchSelector: branchControls({ isOpen: true }),
		});

		const search = screen.getByRole('combobox', { name: 'Find a ref' });
		const createBranch = screen.getByRole('button', { name: 'Create new branch' });
		await new Promise((resolve) => window.setTimeout(resolve, 0));

		expect(document.activeElement).not.toBe(search);
		expect(search.className).toContain('text-base');
		expect(
			Boolean(createBranch.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING),
		).toBe(true);
	});
});
