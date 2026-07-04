import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import GitQuickStatusTray from '../GitQuickStatusTray.svelte';
import type { GitQuickSummaryReady } from '$lib/api/git.js';

function refsFromNames(names: string[]) {
	return names.map((name) => ({
		name,
		ref: `refs/heads/${name}`,
		kind: 'local-branch' as const,
		isCurrent: name === 'main',
	}));
}

function summary(overrides: Partial<GitQuickSummaryReady> = {}): GitQuickSummaryReady {
	return {
		status: 'ready',
		project: '/project',
		repoRoot: '/project',
		branch: 'main',
		hasCommits: true,
		changedFiles: 2,
		trackedChangedFiles: 1,
		untrackedFiles: 1,
		stagedFiles: 1,
		unstagedFiles: 1,
		additions: 3,
		deletions: 1,
		fingerprintVersion: 1,
		fingerprint: 'v1:quick',
		...overrides,
	};
}

describe('GitQuickStatusTray', () => {
	afterEach(async () => {
		cleanup();
		// Allows bits-ui's delayed body-scroll cleanup to run before happy-dom teardown.
		await new Promise((resolve) => window.setTimeout(resolve, 30));
	});

	it('renders a centered loading indicator before the first summary', () => {
		const { container } = render(GitQuickStatusTray, {
			props: {
				isVisible: true,
				summary: null,
				isRefreshing: true,
				onCommit: vi.fn(),
			},
		});

		const tray = screen.getByRole('status', { name: 'Loading...' });
		expect(tray.getAttribute('aria-busy')).toBe('true');
		expect(screen.queryByRole('button')).toBeNull();
		expect(screen.queryByTestId('quick-git-file-summary')).toBeNull();
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
		expect(screen.getByRole('status').getAttribute('aria-busy')).toBe('true');
		expect(container.querySelector('.animate-spin')).toBeNull();
		expect(screen.queryByText('Loading...')).toBeNull();
	});

	it('renders dirty repo counts and runs commit action', async () => {
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
		expect(screen.getByText('•')).toBeTruthy();
		expect(screen.getByText('1 unstaged, 1 staged, 1 untracked')).toBeTruthy();
		expect(screen.getByTestId('quick-git-file-summary').className).toContain(
			'min-[480px]:inline-flex',
		);

		await fireEvent.click(screen.getByRole('button', { name: /Commit/ }));
		expect(onCommit).toHaveBeenCalledOnce();
	});

	it('skips zero-value summary items', () => {
		render(GitQuickStatusTray, {
			props: {
				isVisible: true,
				summary: summary({
					changedFiles: 45,
					trackedChangedFiles: 40,
					untrackedFiles: 5,
					stagedFiles: 0,
					unstagedFiles: 40,
					additions: 0,
					deletions: 0,
				}),
				isRefreshing: false,
				onCommit: vi.fn(),
			},
		});

		expect(screen.getByText('40 unstaged, 5 untracked')).toBeTruthy();
		expect(screen.queryByText('+0')).toBeNull();
		expect(screen.queryByText('-0')).toBeNull();
		expect(screen.queryByText('0 staged')).toBeNull();
		expect(screen.queryByText('•')).toBeNull();
	});

	it('renders clean repo branch and disables commit', () => {
		render(GitQuickStatusTray, {
			props: {
				isVisible: true,
				summary: summary({
					changedFiles: 0,
					trackedChangedFiles: 0,
					untrackedFiles: 0,
					stagedFiles: 0,
					unstagedFiles: 0,
					additions: 0,
					deletions: 0,
				}),
				isRefreshing: false,
				onCommit: vi.fn(),
			},
		});

		expect(screen.getByText('no changes')).toBeTruthy();
		expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
	});

	it('renders the shared branch selector when branch controls are provided', async () => {
		const onToggle = vi.fn();
		const onClose = vi.fn();
		const onCreateBranch = vi.fn();
		const onSwitchBranch = vi.fn();

		render(GitQuickStatusTray, {
			props: {
				isVisible: true,
				summary: summary(),
				isRefreshing: false,
				branchSelector: {
					refs: refsFromNames(['main', 'feature/tray', 'bugfix/login']),
					isOpen: true,
					isLoading: false,
					onToggle,
					onClose,
					onCreateBranch,
					onSwitchBranch,
				},
				onCommit: vi.fn(),
			},
		});

		const search = screen.getByRole('combobox', { name: 'Find a ref' });
		await fireEvent.input(search, { target: { value: 'feature' } });
		expect(screen.queryByText('Branches')).toBeNull();

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
					isOpen: false,
					isLoading: false,
					onToggle,
					onClose: vi.fn(),
					onCreateBranch: vi.fn(),
					onSwitchBranch: vi.fn(),
				},
				onCommit: vi.fn(),
			},
		});

		await fireEvent.click(screen.getByRole('button', { name: /current ref main/i }));

		expect(onToggle).toHaveBeenCalledOnce();
	});

	it('truncates long branch names in the switch confirmation dialog', async () => {
		const longBranch =
			'feature/some-extremely-long-branch-name-that-should-never-wrap-the-confirmation-dialog';
		render(GitQuickStatusTray, {
			props: {
				isVisible: true,
				summary: summary(),
				isRefreshing: false,
				branchSelector: {
					refs: refsFromNames(['main', longBranch]),
					isOpen: true,
					isLoading: false,
					onToggle: vi.fn(),
					onClose: vi.fn(),
					onCreateBranch: vi.fn(),
					onSwitchBranch: vi.fn(),
				},
				onCommit: vi.fn(),
			},
		});

		await fireEvent.click(screen.getByRole('option', { name: new RegExp(longBranch) }));

		const heading = screen.getByRole('heading', {
			name: `Switch to branch ${longBranch}?`,
		});
		const branchText = within(heading).getByText(longBranch);
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
					isOpen: true,
					isLoading: false,
					onToggle: vi.fn(),
					onClose: vi.fn(),
					onCreateBranch: vi.fn(),
					onSwitchBranch: vi.fn(),
				},
				onCommit: vi.fn(),
			},
		});

		const search = screen.getByRole('combobox', { name: 'Find a ref' });
		const createBranch = screen.getByRole('button', { name: 'Create new branch' });
		await new Promise((resolve) => window.setTimeout(resolve, 0));

		expect(document.activeElement).not.toBe(search);
		expect(search.className).toContain('text-[16px]');
		expect(Boolean(createBranch.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(
			true,
		);
	});
});
