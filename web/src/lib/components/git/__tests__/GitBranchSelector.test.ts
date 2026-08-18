import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import GitBranchSelector from '../GitBranchSelector.svelte';

function renderSelector(overrides: Record<string, unknown> = {}) {
	return render(GitBranchSelector, {
		currentBranch: 'main',
		refs: [
			{
				name: 'main',
				ref: 'refs/heads/main',
				kind: 'local-branch',
				updatedAt: null,
				isCurrent: true,
			},
			{
				name: 'feature/search',
				ref: 'refs/heads/feature/search',
				kind: 'local-branch',
				updatedAt: null,
			},
			{
				name: 'origin/main',
				ref: 'refs/remotes/origin/main',
				kind: 'remote-branch',
				updatedAt: null,
			},
		],
		isOpen: true,
		onToggle: vi.fn(),
		onClose: vi.fn(),
		onSwitchBranch: vi.fn(),
		...overrides,
	});
}

describe('GitBranchSelector switch-confirmation dialog', () => {
	afterEach(() => {
		cleanup();
	});

	it('confirms a branch switch and reclaims focus when the dialog closes', async () => {
		const onSwitchBranch = vi.fn();
		const onSwitchDialogClose = vi.fn();
		renderSelector({ onSwitchBranch, onSwitchDialogClose });

		await fireEvent.click(screen.getByRole('option', { name: /feature\/search/ }));
		expect(screen.getByRole('heading', { name: 'Switch to branch feature/search?' })).toBeTruthy();
		expect(onSwitchBranch).not.toHaveBeenCalled();

		await fireEvent.click(screen.getByRole('button', { name: 'Switch branch' }));

		expect(onSwitchBranch).toHaveBeenCalledWith('refs/heads/feature/search', 'local-branch');
		await waitFor(() => expect(onSwitchDialogClose).toHaveBeenCalled());
	});

	it('confirms a remote ref checkout with the full ref value', async () => {
		const onSwitchBranch = vi.fn();
		renderSelector({ onSwitchBranch });

		await fireEvent.click(screen.getByRole('option', { name: /origin\/main/ }));
		expect(screen.getByRole('heading', { name: 'Checkout origin/main?' })).toBeTruthy();

		await fireEvent.click(screen.getByRole('button', { name: 'Checkout ref' }));

		expect(onSwitchBranch).toHaveBeenCalledWith('refs/remotes/origin/main', 'remote-branch');
	});

	it('requests ref search when the query changes', async () => {
		const onSearchRefs = vi.fn();
		renderSelector({ onSearchRefs });

		await fireEvent.input(screen.getByRole('combobox', { name: 'Find a ref' }), {
			target: { value: 'origin/main' },
		});
		await new Promise((resolve) => window.setTimeout(resolve, 180));

		expect(onSearchRefs).toHaveBeenCalledWith('origin/main');
	});

	it('virtualizes large ref lists', () => {
		const refs = Array.from({ length: 120 }, (_, index) => ({
			name: `branch-${index}`,
			ref: `refs/heads/branch-${index}`,
			kind: 'local-branch' as const,
			updatedAt: null,
			isCurrent: index === 0,
		}));
		renderSelector({ currentBranch: 'branch-0', refs });

		expect(screen.getByRole('option', { name: /branch-0/ })).toBeTruthy();
		expect(screen.queryByRole('option', { name: /branch-119/ })).toBeNull();
		expect(document.querySelectorAll('[data-git-ref-virtual-row]').length).toBeLessThan(40);
	});

	it('expands the ref list within the viewport without wrapping long names', () => {
		const longBranch = 'feature/a-branch-name-that-benefits-from-the-available-screen-width';
		renderSelector({
			refs: [
				{ name: 'main', ref: 'refs/heads/main', kind: 'local-branch', isCurrent: true },
				{
					name: longBranch,
					ref: `refs/heads/${longBranch}`,
					kind: 'local-branch',
				},
			],
		});

		const menuClass = document.querySelector('[data-slot="popover-content"]')?.className ?? '';
		const branchText = within(
			screen.getByRole('option', { name: new RegExp(longBranch) }),
		).getByText(longBranch);
		expect(menuClass).toContain('w-[min(36rem,calc(100vw-1rem))]');
		expect(branchText.className).toContain('truncate');
	});

	it('reclaims focus when the switch is cancelled', async () => {
		const onSwitchBranch = vi.fn();
		const onSwitchDialogClose = vi.fn();
		renderSelector({ onSwitchBranch, onSwitchDialogClose });

		await fireEvent.click(screen.getByRole('option', { name: /feature\/search/ }));
		await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

		expect(onSwitchBranch).not.toHaveBeenCalled();
		await waitFor(() => expect(onSwitchDialogClose).toHaveBeenCalled());
	});
});
