import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import GitQuickStatusTray from '../GitQuickStatusTray.svelte';
import type { GitQuickSummaryReady } from '$lib/api/git.js';

const NAME_ASC = { key: 'name', direction: 'asc' } as const;

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

describe('GitQuickStatusTray', () => {
	afterEach(() => {
		cleanup();
	});

	it('keeps Commit available and right-aligned before the first summary', () => {
		const { container } = render(GitQuickStatusTray, {
			props: {
				isVisible: true,
				summary: null,
				isRefreshing: true,
				onCommit: vi.fn(),
			},
		});

		const tray = screen.getByRole('status', { name: 'Loading...' });
		expect(tray.getAttribute('data-slot')).toBe('chat-git-status');
		expect(tray.getAttribute('aria-busy')).toBe('true');
		expect(tray.className).toContain('min-h-14');
		const commit = screen.getByRole('button', { name: /^Commit/ });
		expect((commit as HTMLButtonElement).disabled).toBe(false);
		expect(commit.parentElement?.className).toContain('ml-auto');
		expect(screen.queryByTestId('commit-file-summary')).toBeNull();
		expect(container.querySelector('.animate-spin')).toBeTruthy();
	});

	it('does not render a visible loading indicator while refreshing a ready summary', () => {
		const { container } = render(GitQuickStatusTray, {
			props: {
				isVisible: true,
				summary: summary(),
				isRefreshing: true,
				onCommit: vi.fn(),
			},
		});

		expect(screen.getByText('main')).toBeTruthy();
		expect(screen.getByText('main').parentElement?.getAttribute('data-slot')).toBe('chat-git-branch');
		expect(screen.getByRole('status').getAttribute('aria-busy')).toBe('true');
		expect(container.querySelector('.animate-spin')).toBeNull();
		expect(screen.queryByText('Loading...')).toBeNull();
	});

	it('uses the dirty summary as the Commit label without separate counts', async () => {
		const onCommit = vi.fn();
		render(GitQuickStatusTray, {
			props: {
				isVisible: true,
				summary: summary(),
				isRefreshing: false,
				onCommit,
			},
		});

		expect(screen.getByText('main')).toBeTruthy();
		expect(screen.getByText('+3')).toBeTruthy();
		expect(screen.getByText('/')).toBeTruthy();
		expect(screen.getByText('-1')).toBeTruthy();
		expect(screen.queryByTestId('commit-file-summary')).toBeNull();
		expect(screen.getByRole('button', { name: /^Commit/ }).textContent).toContain('+3');

		await fireEvent.click(screen.getByRole('button', { name: /Commit/ }));
		expect(onCommit).toHaveBeenCalledOnce();
	});

	it('keeps controls visible while disabling non-anchor announcements', () => {
		const { container } = render(GitQuickStatusTray, {
			props: {
				isVisible: true,
				summary: summary(),
				isRefreshing: false,
				onCommit: vi.fn(),
				announcementsEnabled: false,
			},
		});

		const tray = container.firstElementChild?.firstElementChild;
		expect(tray?.getAttribute('role')).toBeNull();
		expect(tray?.getAttribute('aria-live')).toBe('off');
		expect(screen.getByRole('button', { name: /Commit/ })).toBeTruthy();
	});

	it('skips zero-value summary items', () => {
		render(GitQuickStatusTray, {
			props: {
				isVisible: true,
				summary: summary({
					hasChanges: true,
					hasUntracked: true,
					diffStats: { additions: 0, deletions: 0 },
				}),
				isRefreshing: false,
				onCommit: vi.fn(),
			},
		});

		expect(screen.getByText('New files')).toBeTruthy();
		expect(screen.queryByText('+0')).toBeNull();
		expect(screen.queryByText('-0')).toBeNull();
		expect(screen.queryByText('0 staged')).toBeNull();
		expect(screen.queryByText('•')).toBeNull();
	});

	it('renders a muted clean button that still opens Commit', () => {
		render(GitQuickStatusTray, {
			props: {
				isVisible: true,
				summary: summary({
					hasChanges: false,
					hasUntracked: false,
					diffStats: { additions: 0, deletions: 0 },
				}),
				isRefreshing: false,
				onCommit: vi.fn(),
			},
		});

		expect(screen.getByRole('button').className).toContain('text-muted-foreground');
		expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(false);
	});

	it('renders the shared branch selector when branch controls are provided', async () => {
		const onToggle = vi.fn();
		const onClose = vi.fn();
		const onCreateBranch = vi.fn();
		const onSwitchBranch = vi.fn();
		const onSearchRefs = vi.fn();
		const onSortRefs = vi.fn();

		render(GitQuickStatusTray, {
			props: {
				isVisible: true,
				summary: summary(),
				isRefreshing: false,
				branchSelector: {
					refs: refsFromNames(['main', 'feature/tray', 'bugfix/login']),
					sort: NAME_ASC,
					isOpen: true,
					isLoading: false,
					onToggle,
					onClose,
					onCreateBranch,
					onSwitchBranch,
					onSearchRefs,
					onSortRefs,
				},
				onCommit: vi.fn(),
			},
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

		await fireEvent.click(screen.getByRole('option', { name: /feature\/tray/ }));
		expect(onClose).toHaveBeenCalledOnce();
		expect(screen.getByRole('heading', { name: 'Switch to branch feature/tray?' })).toBeTruthy();
		expect(onSwitchBranch).not.toHaveBeenCalled();

		await fireEvent.click(screen.getByRole('button', { name: 'Switch branch' }));
		expect(onSwitchBranch).toHaveBeenCalledWith('refs/heads/feature/tray', 'local-branch');

		await fireEvent.click(screen.getByRole('button', { name: 'Create new branch' }));
		expect(onCreateBranch).toHaveBeenCalledOnce();
		expect(onClose).toHaveBeenCalledTimes(2);
	});

	it('opens the shared branch selector from the trigger', async () => {
		const onToggle = vi.fn();
		render(GitQuickStatusTray, {
			props: {
				isVisible: true,
				summary: summary(),
				isRefreshing: false,
				branchSelector: {
					refs: refsFromNames(['main', 'feature/tray']),
					sort: NAME_ASC,
					isOpen: false,
					isLoading: false,
					onToggle,
					onClose: vi.fn(),
					onCreateBranch: vi.fn(),
					onSwitchBranch: vi.fn(),
					onSortRefs: vi.fn(),
				},
				onCommit: vi.fn(),
			},
		});

		await fireEvent.click(screen.getByRole('button', { name: /current ref main/i }));

		expect(onToggle).toHaveBeenCalledOnce();
	});

	it('expands the branch control on wide screens without wrapping on narrow screens', () => {
		const longBranch = 'feature/a-long-current-branch-name';
		render(GitQuickStatusTray, {
			props: {
				isVisible: true,
				summary: summary({ branch: longBranch }),
				isRefreshing: false,
				branchSelector: {
					refs: refsFromNames([longBranch]),
					sort: NAME_ASC,
					isOpen: false,
					isLoading: false,
					onToggle: vi.fn(),
					onClose: vi.fn(),
					onCreateBranch: vi.fn(),
					onSwitchBranch: vi.fn(),
					onSortRefs: vi.fn(),
				},
				onCommit: vi.fn(),
			},
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
		render(GitQuickStatusTray, {
			props: {
				isVisible: true,
				summary: summary(),
				isRefreshing: false,
				branchSelector: {
					refs: refsFromNames(['main', longBranch]),
					sort: NAME_ASC,
					isOpen: true,
					isLoading: false,
					onToggle: vi.fn(),
					onClose: vi.fn(),
					onCreateBranch: vi.fn(),
					onSwitchBranch: vi.fn(),
					onSortRefs: vi.fn(),
				},
				onCommit: vi.fn(),
			},
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
		render(GitQuickStatusTray, {
			props: {
				isVisible: true,
				summary: summary(),
				isRefreshing: false,
				isMobile: true,
				branchSelector: {
					refs: refsFromNames(['main', 'feature/tray']),
					sort: NAME_ASC,
					isOpen: true,
					isLoading: false,
					onToggle: vi.fn(),
					onClose: vi.fn(),
					onCreateBranch: vi.fn(),
					onSwitchBranch: vi.fn(),
					onSortRefs: vi.fn(),
				},
				onCommit: vi.fn(),
			},
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
