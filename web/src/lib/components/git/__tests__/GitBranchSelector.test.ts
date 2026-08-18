import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import GitBranchSelector from '../GitBranchSelector.svelte';

const NAME_ASC = { key: 'name', direction: 'asc' } as const;
const UPDATED_DESC = { key: 'updated', direction: 'desc' } as const;

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
		sort: NAME_ASC,
		isOpen: true,
		onToggle: vi.fn(),
		onClose: vi.fn(),
		onSwitchBranch: vi.fn(),
		onSortRefs: vi.fn(),
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

	it('exposes accessible sort intent outside the ref listbox', async () => {
		const onSortRefs = vi.fn();
		const view = renderSelector({ onSortRefs });
		const nameSort = screen.getByRole('button', {
			name: 'Reverse Name sort, Z to A',
		});
		const updatedSort = screen.getByRole('button', {
			name: 'Sort by Updated, newest first',
		});
		const sortGroup = screen.getByRole('group', { name: 'Sort refs' });
		const listbox = screen.getByRole('listbox', { name: 'Refs' });

		expect(nameSort.getAttribute('aria-pressed')).toBe('true');
		expect(updatedSort.getAttribute('aria-pressed')).toBe('false');
		expect(nameSort.hasAttribute('aria-sort')).toBe(false);
		expect(listbox.contains(nameSort)).toBe(false);
		expect(sortGroup.className).toContain('overflow-y-auto');
		expect(sortGroup.style.getPropertyValue('scrollbar-gutter')).toBe('stable');
		expect(listbox.style.getPropertyValue('scrollbar-gutter')).toBe('stable');

		await fireEvent.click(updatedSort);
		expect(onSortRefs).toHaveBeenCalledWith('updated', '');

		await view.rerender({ sort: UPDATED_DESC });
		expect(
			screen
				.getByRole('button', { name: 'Reverse Updated sort, oldest first' })
				.getAttribute('aria-pressed'),
		).toBe('true');
	});

	it('sorts the current query without firing its pending search debounce', async () => {
		const onSearchRefs = vi.fn();
		const onSortRefs = vi.fn();
		renderSelector({ onSearchRefs, onSortRefs });

		await fireEvent.input(screen.getByRole('combobox', { name: 'Find a ref' }), {
			target: { value: '  feature  ' },
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Sort by Updated, newest first' }));
		await new Promise((resolve) => window.setTimeout(resolve, 180));

		expect(onSortRefs).toHaveBeenCalledWith('updated', 'feature');
		expect(onSearchRefs).not.toHaveBeenCalled();
	});

	it('renders canonical Updated timestamps and accessible unavailable values', () => {
		const updatedAt = new Date(Date.now() - 2 * 60 * 60 * 1_000).toISOString();
		renderSelector({
			refs: [
				{
					name: 'recent',
					ref: 'refs/heads/recent',
					kind: 'local-branch',
					updatedAt,
				},
				{
					name: 'missing',
					ref: 'refs/heads/missing',
					kind: 'local-branch',
					updatedAt: null,
				},
				{
					name: 'invalid',
					ref: 'refs/heads/invalid',
					kind: 'local-branch',
					updatedAt: 'not-an-iso-timestamp',
				},
				{
					name: 'absent',
					ref: 'refs/heads/absent',
					kind: 'local-branch',
				},
			],
		});

		const timestamp = document.querySelector('time');
		expect(timestamp?.getAttribute('datetime')).toBe(updatedAt);
		expect(timestamp?.getAttribute('title')).toBeTruthy();
		expect(timestamp?.textContent?.trim()).toBeTruthy();
		expect(screen.getAllByTitle('Updated time unavailable')).toHaveLength(3);
		expect(screen.getAllByText('Updated time unavailable')).toHaveLength(3);
	});

	it('preserves server ordering while applying only the local query filter', async () => {
		renderSelector({
			refs: [
				{
					name: 'z-match',
					ref: 'refs/heads/z-match',
					kind: 'local-branch',
					updatedAt: null,
				},
				{
					name: 'a-match',
					ref: 'refs/heads/a-match',
					kind: 'local-branch',
					updatedAt: null,
				},
				{ name: 'middle', ref: 'refs/heads/middle', kind: 'local-branch', updatedAt: null },
			],
		});

		expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
			expect.stringContaining('z-match'),
			expect.stringContaining('a-match'),
			expect.stringContaining('middle'),
		]);

		await fireEvent.input(screen.getByRole('combobox', { name: 'Find a ref' }), {
			target: { value: 'match' },
		});
		expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
			expect.stringContaining('z-match'),
			expect.stringContaining('a-match'),
		]);
	});

	it('isolates malformed rows without changing virtual row height', () => {
		const malformed = {
			ref: 'refs/heads/malformed',
			kind: 'local-branch',
			updatedAt: null,
		};
		Object.defineProperty(malformed, 'name', {
			get() {
				throw new Error('malformed ref');
			},
		});
		renderSelector({
			refs: [
				{ name: 'first', ref: 'refs/heads/first', kind: 'local-branch', updatedAt: null },
				malformed,
				{ name: 'last', ref: 'refs/heads/last', kind: 'local-branch', updatedAt: null },
			],
		});

		expect(screen.getByRole('option', { name: /first/ })).toBeTruthy();
		expect(screen.getByRole('option', { name: /Ref unavailable/ })).toBeTruthy();
		expect(screen.getByRole('option', { name: /last/ })).toBeTruthy();
		expect(document.querySelectorAll('[data-git-ref-virtual-row]')).toHaveLength(3);
		expect(
			document.querySelector('[data-git-ref-virtual-row="unavailable-1"]')?.getAttribute('style'),
		).toContain('height: 36px');
	});

	it('keeps sort-button focus while loading and replacing results', async () => {
		const view = renderSelector();
		await new Promise((resolve) => window.setTimeout(resolve, 0));
		const updatedSort = screen.getByRole('button', {
			name: 'Sort by Updated, newest first',
		});
		updatedSort.focus();

		await view.rerender({ isLoading: true });
		expect(document.activeElement).toBe(updatedSort);

		await view.rerender({
			isLoading: false,
			refs: [
				{
					name: 'replacement',
					ref: 'refs/heads/replacement',
					kind: 'local-branch',
					updatedAt: null,
				},
			],
		});
		expect(document.activeElement).toBe(updatedSort);
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
