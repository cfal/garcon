import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { GitWorktreeItem } from '$lib/api/git.js';
import { formatRelativeTimestamp } from '$lib/utils/relative-timestamp.js';
import GitWorktreePickerModal from '../GitWorktreePickerModal.svelte';
import GitWorktreePickerEscapeHost from './GitWorktreePickerEscapeHost.svelte';

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
	vi.useRealTimers();
	vi.clearAllMocks();
});

describe('GitWorktreePickerModal', () => {
	it('keeps stable responsive geometry while loading and after refresh', async () => {
		const view = renderPicker([], { isLoading: true });
		const dialog = screen.getByRole('dialog', { name: 'Select worktree' });
		const initialClassName = dialog.className;

		expect(initialClassName).toContain('top-[var(--app-viewport-center-y)]');
		expect(initialClassName).toContain('h-[min(36rem,calc(var(--app-height)-1rem))]');
		expect(initialClassName).toContain('w-[calc(100vw-1rem)]');
		expect(dialog.firstElementChild?.className).toContain('h-full');

		await view.rerender({
			isLoading: false,
			worktrees: [worktree('loaded', '2026-07-15T10:00:00.000Z')],
		});

		expect(dialog.className).toBe(initialClassName);
		expect(screen.getByRole('option', { name: /loaded/ })).toBeTruthy();
	});

	it('uses mobile-safe input text and stacks row timestamps on narrow screens', () => {
		renderPicker([worktree('mobile', '2026-07-15T10:00:00.000Z')]);

		const filter = screen.getByRole('combobox', { name: 'Filter worktrees' });
		expect(filter.className).toContain('text-base');
		expect(filter.className).toContain('md:text-base');
		expect(filter.className).not.toMatch(/(?:^|\s)text-sm(?:\s|$)/);
		expect(filter.className).not.toContain('md:text-sm');

		const timestamp = screen.getByRole('time');
		expect(timestamp.parentElement?.className).toContain('flex-col');
		expect(timestamp.parentElement?.className).toContain('sm:flex-row');
		expect(timestamp.className).toContain('max-w-full');
		expect(timestamp.className).toContain('sm:max-w-32');
		expect(screen.getByText('|').className).toContain('hidden');
	});

	it('focuses the filter and initially renders newest worktrees first', async () => {
		renderPicker([
			worktree('older', '2026-07-13T10:00:00.000Z'),
			worktree('newer', '2026-07-15T10:00:00.000Z'),
		]);

		const filter = screen.getByRole('combobox', { name: 'Filter worktrees' });
		await waitFor(() => expect(document.activeElement).toBe(filter));
		expect(renderedWorktreeNames()).toEqual(['newer', 'older']);
		const activeOptionId = filter.getAttribute('aria-activedescendant');
		expect(activeOptionId).toBeTruthy();
		expect(document.getElementById(activeOptionId ?? '')).toBeTruthy();
		for (const option of screen.getByRole('listbox', { name: 'Select worktree' }).children) {
			expect(option.getAttribute('tabindex')).toBe('-1');
		}
	});

	it('keeps a selected path actionable when sorting moves it beyond the virtual window', async () => {
		const onSelect = vi.fn();
		const items = Array.from({ length: 120 }, (_, index) =>
			worktree(`worktree-${index.toString().padStart(3, '0')}`, '2026-07-15T10:00:00.000Z'),
		);
		renderPicker(items, { onSelect });
		const filter = screen.getByRole('combobox', { name: 'Filter worktrees' });
		const initialOption = screen.getByRole('option', { name: /worktree-000/ });

		await fireEvent.mouseMove(initialOption);
		await chooseSortOrder(
			screen.getByRole('button', { name: 'Sort worktrees' }),
			'Alphabetical (descending)',
		);

		await waitFor(() => {
			const activeOptionId = filter.getAttribute('aria-activedescendant');
			expect(activeOptionId).toBeTruthy();
			expect(document.getElementById(activeOptionId ?? '')).toBeTruthy();
			expect(screen.getByRole('option', { name: /worktree-000/ })).toBeTruthy();
		});
		await fireEvent.keyDown(filter, { key: 'Enter' });

		expect(onSelect).toHaveBeenCalledWith('/workspace/worktree-000');
	});

	it('keeps a deep virtual selection mounted when the create form shrinks the list', async () => {
		let resizeCallback!: ResizeObserverCallback;
		class TestResizeObserver {
			constructor(callback: ResizeObserverCallback) {
				resizeCallback = callback;
			}

			observe = vi.fn();
			unobserve = vi.fn();
			disconnect = vi.fn();
		}
		vi.stubGlobal('ResizeObserver', TestResizeObserver);
		const items = Array.from({ length: 120 }, (_, index) =>
			worktree(`worktree-${index.toString().padStart(3, '0')}`, '2026-07-15T10:00:00.000Z'),
		);
		const view = renderPicker(items);

		try {
			const filter = screen.getByRole('combobox', { name: 'Filter worktrees' });
			await fireEvent.mouseMove(screen.getByRole('option', { name: /worktree-000/ }));
			await chooseSortOrder(
				screen.getByRole('button', { name: 'Sort worktrees' }),
				'Alphabetical (descending)',
			);
			await waitFor(() => {
				expect(screen.getByRole('option', { name: /worktree-000/ })).toBeTruthy();
			});

			await fireEvent.click(screen.getByRole('button', { name: 'New worktree' }));
			resizeCallback(
				[{ contentRect: { height: 120 } } as ResizeObserverEntry],
				{} as ResizeObserver,
			);

			await waitFor(() => {
				const activeOptionId = filter.getAttribute('aria-activedescendant');
				expect(activeOptionId).toBeTruthy();
				expect(document.getElementById(activeOptionId ?? '')).toBeTruthy();
				expect(screen.getByRole('option', { name: /worktree-000/ })).toBeTruthy();
			});
		} finally {
			view.unmount();
			vi.unstubAllGlobals();
		}
	});

	it('uses stable option identities and scrolls the active row after loading returns', async () => {
		const items = [
			worktree('alpha', '2026-07-15T10:00:00.000Z'),
			worktree('beta', '2026-07-14T10:00:00.000Z'),
		];
		const view = renderPicker(items);
		const filter = screen.getByRole('combobox', { name: 'Filter worktrees' });
		const alphaId = filter.getAttribute('aria-activedescendant');

		await fireEvent.input(filter, { target: { value: 'beta' } });
		const betaId = filter.getAttribute('aria-activedescendant');
		expect(betaId).toBe(screen.getByRole('option', { name: /beta/ }).id);
		expect(betaId).not.toBe(alphaId);

		await fireEvent.input(filter, { target: { value: '' } });
		expect(filter.getAttribute('aria-activedescendant')).toBe(alphaId);

		vi.mocked(HTMLElement.prototype.scrollIntoView).mockClear();
		await view.rerender({ isLoading: true, worktrees: items });
		await view.rerender({ isLoading: false, worktrees: items });
		await waitFor(() => expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled());
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

	it('counts rendered missing worktrees in the footer', async () => {
		renderPicker([
			worktree('available', '2026-07-15T10:00:00.000Z'),
			worktree('missing', null, { isPathMissing: true }),
		]);
		const filter = screen.getByRole('combobox', { name: 'Filter worktrees' });

		expect(screen.getByText('2 worktrees')).toBeTruthy();
		await fireEvent.input(filter, { target: { value: 'missing' } });

		expect(screen.getByRole('option', { name: /missing/ })).toBeTruthy();
		expect(screen.getByText('1 of 2 worktrees')).toBeTruthy();
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
		const initialActiveOption = filter.getAttribute('aria-activedescendant');

		await fireEvent.keyDown(filter, { key: 'ArrowDown' });
		expect(filter.getAttribute('aria-activedescendant')).not.toBe(initialActiveOption);
		await fireEvent.keyDown(filter, { key: 'Enter' });
		expect(onSelect).toHaveBeenCalledWith('/workspace/two');

		onSelect.mockClear();
		await fireEvent.input(filter, { target: { value: 'one' } });
		await fireEvent.keyDown(filter, { key: 'Enter' });
		expect(onSelect).toHaveBeenCalledWith('/workspace/one');
	});

	it('changes the effective row only after actual pointer movement', async () => {
		const onSelect = vi.fn();
		renderPicker(
			[worktree('one', '2026-07-15T10:00:00.000Z'), worktree('two', '2026-07-14T10:00:00.000Z')],
			{ onSelect },
		);
		const filter = screen.getByRole('combobox', { name: 'Filter worktrees' });
		const [, secondOption] = screen.getAllByRole('option');

		await fireEvent.mouseEnter(secondOption);
		await fireEvent.keyDown(filter, { key: 'Enter' });
		expect(onSelect).toHaveBeenLastCalledWith('/workspace/one');

		await fireEvent.mouseMove(secondOption);
		await fireEvent.keyDown(filter, { key: 'Enter' });
		expect(onSelect).toHaveBeenLastCalledWith('/workspace/two');
	});

	it('does not select when IME composition confirms with Enter', async () => {
		const onSelect = vi.fn();
		renderPicker([worktree('selectable', '2026-07-15T10:00:00.000Z')], { onSelect });
		const filter = screen.getByRole('combobox', { name: 'Filter worktrees' });

		await fireEvent.keyDown(filter, { key: 'Enter', isComposing: true });
		expect(onSelect).not.toHaveBeenCalled();

		await fireEvent.keyDown(filter, { key: 'Enter' });
		expect(onSelect).toHaveBeenCalledWith('/workspace/selectable');
	});

	it('does not select for Safari IME confirmation key events', async () => {
		const onSelect = vi.fn();
		renderPicker([worktree('selectable', '2026-07-15T10:00:00.000Z')], { onSelect });
		const filter = screen.getByRole('combobox', { name: 'Filter worktrees' });

		await fireEvent.keyDown(filter, { key: 'Enter', keyCode: 229 });
		expect(onSelect).not.toHaveBeenCalled();
	});

	it('does not treat sort keyboard events as worktree selection', async () => {
		const onSelect = vi.fn();
		renderPicker([worktree('selectable', '2026-07-15T10:00:00.000Z')], { onSelect });
		const sort = screen.getByRole('button', { name: 'Sort worktrees' });

		await fireEvent.keyDown(sort, { key: 'Enter' });
		expect(onSelect).not.toHaveBeenCalled();
	});

	it('closes the sort menu with Escape without closing the picker', async () => {
		const onClose = vi.fn();
		renderPicker([worktree('selectable', '2026-07-15T10:00:00.000Z')], { onClose });
		const sort = screen.getByRole('button', { name: 'Sort worktrees' });

		await openSortMenu(sort);
		const option = await screen.findByRole('option', { name: 'Alphabetical (ascending)' });
		await fireEvent.keyDown(option, { key: 'Escape' });

		await waitFor(() =>
			expect(screen.queryByRole('option', { name: 'Alphabetical (ascending)' })).toBeNull(),
		);
		expect(onClose).not.toHaveBeenCalled();
		expect(screen.getByRole('combobox', { name: 'Filter worktrees' })).toBeTruthy();
	});

	it('does not select an unavailable result with Enter', async () => {
		const onSelect = vi.fn();
		renderPicker([worktree('missing', null, { isPathMissing: true })], { onSelect });
		const filter = screen.getByRole('combobox', { name: 'Filter worktrees' });

		await fireEvent.keyDown(filter, { key: 'Enter' });
		expect(onSelect).not.toHaveBeenCalled();
	});

	it('does not expose or select stale options while loading', async () => {
		const onSelect = vi.fn();
		const view = renderPicker([worktree('stale', '2026-07-15T10:00:00.000Z')], {
			onSelect,
		});
		const filter = screen.getByRole('combobox', { name: 'Filter worktrees' });

		await view.rerender({ isLoading: true });
		expect(filter.getAttribute('aria-activedescendant')).toBeNull();
		expect(screen.getByRole('listbox', { name: 'Select worktree' }).getAttribute('aria-busy')).toBe(
			'true',
		);
		await fireEvent.keyDown(filter, { key: 'Enter' });
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

	it('uses the current render time for worktrees returned by refresh', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date('2026-07-15T10:00:00.000Z'));
		const view = renderPicker([worktree('old', '2026-07-15T09:00:00.000Z')]);

		vi.setSystemTime(new Date('2026-07-15T10:05:00.000Z'));
		await view.rerender({
			worktrees: [worktree('refreshed', '2026-07-15T10:05:00.000Z')],
		});

		expect(screen.getByText('Modified now')).toBeTruthy();
	});

	it('renders malformed server timestamps as unavailable', () => {
		renderPicker([worktree('malformed', '2026-02-30T10:00:00.000Z')]);

		expect(screen.getByText('Modified unavailable')).toBeTruthy();
		expect(screen.queryByRole('time')).toBeNull();
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

	it('falls back to the first selectable row when refresh removes the selection', async () => {
		const onSelect = vi.fn();
		const view = renderPicker(
			[
				worktree('newer', '2026-07-15T10:00:00.000Z'),
				worktree('older', '2026-07-14T10:00:00.000Z'),
			],
			{ onSelect },
		);
		const filter = screen.getByRole('combobox', { name: 'Filter worktrees' });
		await fireEvent.keyDown(filter, { key: 'ArrowDown' });

		await view.rerender({
			worktrees: [worktree('replacement', '2026-07-16T10:00:00.000Z')],
		});
		await fireEvent.keyDown(filter, { key: 'Enter' });

		expect(onSelect).toHaveBeenCalledWith('/workspace/replacement');
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

	it('gives the create form first refusal on app-level capture-phase Escape', async () => {
		render(GitWorktreePickerEscapeHost);

		await fireEvent.click(screen.getByRole('button', { name: 'New worktree' }));
		const branchInput = screen.getByPlaceholderText('Branch name (e.g. fix/login-bug)');
		await fireEvent.input(branchInput, { target: { value: 'feature/in-progress' } });

		await fireEvent.keyDown(window, { key: 'Escape' });
		expect(screen.queryByDisplayValue('feature/in-progress')).toBeNull();
		expect(screen.getByRole('dialog', { name: 'Select worktree' })).toBeTruthy();
		await waitFor(() =>
			expect(document.activeElement).toBe(
				screen.getByRole('combobox', { name: 'Filter worktrees' }),
			),
		);

		await fireEvent.keyDown(window, { key: 'Escape' });
		await waitFor(() =>
			expect(screen.queryByRole('dialog', { name: 'Select worktree' })).toBeNull(),
		);
	});

	it('does not select a worktree from the filter while the create form is open', async () => {
		const onSelect = vi.fn();
		renderPicker([worktree('main', '2026-07-15T10:00:00.000Z')], { onSelect });

		await fireEvent.click(screen.getByRole('button', { name: 'New worktree' }));
		const branchInput = screen.getByPlaceholderText('Branch name (e.g. fix/login-bug)');
		await fireEvent.input(branchInput, { target: { value: 'feature/in-progress' } });

		const filter = screen.getByRole('combobox', { name: 'Filter worktrees' });
		await fireEvent.click(filter);
		await fireEvent.keyDown(filter, { key: 'Enter' });

		expect(onSelect).not.toHaveBeenCalled();
		expect(screen.getByDisplayValue('feature/in-progress')).toBeTruthy();

		await fireEvent.keyDown(filter, { key: 'Escape' });
		expect(screen.queryByDisplayValue('feature/in-progress')).toBeNull();
		expect(onSelect).not.toHaveBeenCalled();
	});
});
