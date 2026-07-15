import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { GitWorktreeItem } from '$lib/api/git.js';
import { formatRelativeTimestamp } from '$lib/utils/relative-timestamp.js';
import GitWorktreePickerModal from '../GitWorktreePickerModal.svelte';

function worktree(
	name: string,
	lastModifiedAt: string | null,
	overrides: Partial<GitWorktreeItem> = {},
): GitWorktreeItem {
	return {
		name,
		path: `/workspace/${name}`,
		branch: name,
		isCurrent: false,
		isMain: false,
		isPathMissing: false,
		lastModifiedAt,
		...overrides,
	};
}

function renderPicker(worktrees: GitWorktreeItem[], overrides: Record<string, unknown> = {}) {
	return render(GitWorktreePickerModal, {
		worktrees,
		isLoading: false,
		isCreating: false,
		errorMessage: null,
		onSelect: vi.fn(),
		onCreate: vi.fn(),
		onRefresh: vi.fn(),
		onClose: vi.fn(),
		...overrides,
	});
}

function renderedWorktreeNames(): string[] {
	return screen
		.getAllByRole('option')
		.filter(
			(option) =>
				option.closest('[role="listbox"]')?.getAttribute('aria-label') === 'Select worktree',
		)
		.map((option) => option.querySelector('.text-sm.font-medium')?.textContent?.trim() ?? '');
}

async function openSortMenu(trigger: HTMLElement): Promise<void> {
	await fireEvent.pointerDown(trigger, {
		button: 0,
		ctrlKey: false,
		pointerType: 'mouse',
	});
}

async function chooseSortOrder(trigger: HTMLElement, label: string): Promise<void> {
	await openSortMenu(trigger);
	await fireEvent.pointerUp(await screen.findByRole('option', { name: label }), {
		pointerType: 'mouse',
	});
}

beforeAll(() => {
	HTMLElement.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe('GitWorktreePickerModal', () => {
	it('focuses the filter and initially renders newest worktrees first', async () => {
		renderPicker([
			worktree('older', '2026-07-13T10:00:00.000Z'),
			worktree('newer', '2026-07-15T10:00:00.000Z'),
		]);

		const filter = screen.getByRole('combobox', { name: 'Filter worktrees' });
		await waitFor(() => expect(document.activeElement).toBe(filter));
		expect(renderedWorktreeNames()).toEqual(['newer', 'older']);
		expect(filter.getAttribute('aria-activedescendant')).toBeTruthy();
	});

	it('offers the three sort choices and applies alphabetical ordering', async () => {
		renderPicker([
			worktree('alpha', '2026-07-13T10:00:00.000Z'),
			worktree('beta', '2026-07-15T10:00:00.000Z'),
		]);
		const sort = screen.getByRole('button', { name: 'Sort worktrees' });

		await openSortMenu(sort);
		expect(await screen.findByRole('option', { name: 'Alphabetical (ascending)' })).toBeTruthy();
		expect(screen.getByRole('option', { name: 'Alphabetical (descending)' })).toBeTruthy();
		expect(screen.getByRole('option', { name: 'Last Modified Time' })).toBeTruthy();

		await fireEvent.pointerUp(screen.getByRole('option', { name: 'Alphabetical (ascending)' }), {
			pointerType: 'mouse',
		});
		expect(renderedWorktreeNames()).toEqual(['alpha', 'beta']);

		await chooseSortOrder(sort, 'Alphabetical (descending)');
		expect(renderedWorktreeNames()).toEqual(['beta', 'alpha']);
	});

	it('filters locally, reports the count, and shows a dedicated no-match state', async () => {
		renderPicker([
			worktree('main', '2026-07-15T10:00:00.000Z'),
			worktree('feature-search', '2026-07-14T10:00:00.000Z'),
		]);
		const filter = screen.getByRole('combobox', { name: 'Filter worktrees' });

		await fireEvent.input(filter, { target: { value: 'search' } });
		expect(renderedWorktreeNames()).toEqual(['feature-search']);
		expect(screen.getByText('1 of 2 worktrees')).toBeTruthy();

		await fireEvent.input(filter, { target: { value: 'absent' } });
		expect(screen.getByText('No matching worktrees')).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Sort worktrees' })).toBeTruthy();
	});

	it('does not report an API failure as an empty filter result', () => {
		renderPicker([], { errorMessage: 'Unable to load worktrees' });

		expect(screen.getByText('Unable to load worktrees')).toBeTruthy();
		expect(screen.queryByText('No matching worktrees')).toBeNull();
	});

	it('selects the effective filtered row with Enter and navigates with arrow keys', async () => {
		const onSelect = vi.fn();
		renderPicker(
			[worktree('one', '2026-07-15T10:00:00.000Z'), worktree('two', '2026-07-14T10:00:00.000Z')],
			{ onSelect },
		);
		const filter = screen.getByRole('combobox', { name: 'Filter worktrees' });

		await fireEvent.keyDown(filter, { key: 'ArrowDown' });
		await fireEvent.keyDown(filter, { key: 'Enter' });
		expect(onSelect).toHaveBeenCalledWith('/workspace/two');

		onSelect.mockClear();
		await fireEvent.input(filter, { target: { value: 'one' } });
		await fireEvent.keyDown(filter, { key: 'Enter' });
		expect(onSelect).toHaveBeenCalledWith('/workspace/one');
	});

	it('does not select for IME Enter, sort keyboard events, or unavailable results', async () => {
		const onSelect = vi.fn();
		renderPicker([worktree('missing', null, { isPathMissing: true })], { onSelect });
		const filter = screen.getByRole('combobox', { name: 'Filter worktrees' });

		await fireEvent.keyDown(filter, { key: 'Enter', isComposing: true });
		await fireEvent.keyDown(filter, { key: 'Enter' });
		const sort = screen.getByRole('button', { name: 'Sort worktrees' });
		await fireEvent.keyDown(sort, { key: 'Enter' });
		expect(onSelect).not.toHaveBeenCalled();
	});

	it('shows compact modification labels with exact tooltips and an unavailable state', () => {
		const timestamp = new Date(Date.now() - 2 * 60 * 60 * 1_000).toISOString();
		const expected = formatRelativeTimestamp(timestamp, new Date());
		renderPicker([worktree('recent', timestamp), worktree('unknown', null)]);

		const time = screen.getByText(new RegExp(`Modified ${expected?.label ?? ''}`));
		expect(time.getAttribute('title')).toBe(expected?.tooltip);
		expect(screen.getByText('Modified unavailable').getAttribute('title')).toBe(
			'Last modified time unavailable',
		);
	});

	it('keeps filter and sort state when refreshed props arrive', async () => {
		const view = renderPicker([
			worktree('alpha', '2026-07-13T10:00:00.000Z'),
			worktree('beta', '2026-07-15T10:00:00.000Z'),
		]);
		const filter = screen.getByRole('combobox', { name: 'Filter worktrees' });
		const sort = screen.getByRole('button', { name: 'Sort worktrees' });
		await fireEvent.input(filter, { target: { value: 'a' } });
		await chooseSortOrder(sort, 'Alphabetical (descending)');

		await view.rerender({
			worktrees: [
				worktree('alpha', '2026-07-13T10:00:00.000Z'),
				worktree('gamma', '2026-07-16T10:00:00.000Z'),
			],
		});

		expect((filter as HTMLInputElement).value).toBe('a');
		expect(screen.getByRole('button', { name: 'Sort worktrees' }).textContent).toContain(
			'Alphabetical (descending)',
		);
		expect(renderedWorktreeNames()).toEqual(['gamma', 'alpha']);
	});

	it('keeps create-form Enter and Escape behavior separate from worktree selection', async () => {
		const onCreate = vi.fn();
		const onSelect = vi.fn();
		const onClose = vi.fn();
		renderPicker([worktree('main', '2026-07-15T10:00:00.000Z')], {
			onCreate,
			onSelect,
			onClose,
		});

		await fireEvent.click(screen.getByRole('button', { name: 'New worktree' }));
		const branchInput = screen.getByPlaceholderText('Branch name (e.g. fix/login-bug)');
		expect(document.activeElement).toBe(branchInput);
		await fireEvent.input(branchInput, { target: { value: 'feature/search' } });
		await fireEvent.keyDown(branchInput, { key: 'Enter' });
		expect(onCreate).toHaveBeenCalledWith(
			'../.worktrees/feature-search',
			'feature/search',
			undefined,
		);
		expect(onSelect).not.toHaveBeenCalled();

		await fireEvent.keyDown(branchInput, { key: 'Escape' });
		expect(screen.queryByPlaceholderText('Branch name (e.g. fix/login-bug)')).toBeNull();
		expect(onClose).not.toHaveBeenCalled();
		await waitFor(() =>
			expect(document.activeElement).toBe(
				screen.getByRole('combobox', { name: 'Filter worktrees' }),
			),
		);
	});
});
