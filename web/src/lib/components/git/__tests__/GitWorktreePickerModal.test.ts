import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { GitWorktreeItem } from '$lib/api/git.js';
import { formatRelativeTimestamp } from '$lib/utils/relative-timestamp.js';
import GitWorktreePickerModal from '../GitWorktreePickerModal.svelte';
import GitWorktreePickerEscapeHost from './GitWorktreePickerEscapeHost.svelte';
import { pickerFixture, worktree, type PickerPort } from './worktree-picker-fixture.js';
import { ExecutorsStore } from '$lib/executors/executors-store.svelte.js';
import { NotificationsStore } from '$lib/stores/notifications.svelte.js';
import { generateGitName } from '$lib/api/git-name.js';

vi.mock('$lib/context', async (original) => ({
	...await original<typeof import('$lib/context')>(),
	getExecutors: () => new ExecutorsStore(),
	getNotifications: () => new NotificationsStore(),
}));
vi.mock('$lib/api/git-name.js', () => ({ generateGitName: vi.fn() }));

function renderPicker(worktrees: GitWorktreeItem[], initial: Partial<PickerPort> & { description?: string } = {}) {
	let values = { worktrees, ...initial };
	function props() {
		const { description, ...session } = values;
		return { session: pickerFixture(session), description };
	}
	const view = render(GitWorktreePickerModal, props());
	return {
		...view,
		rerender(update: typeof initial) {
			values = { ...values, ...update };
			return view.rerender(props());
		},
	};
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

it('disables both refresh entry points while a worktree is being created', async () => {
	const refresh = vi.fn();
	renderPicker([], { isCreating: true, loadError: 'Previous list failed', refresh });
	for (const name of ['Refresh worktrees', 'Retry']) {
		const button = screen.getByRole('button', { name }) as HTMLButtonElement;
		expect(button.disabled).toBe(true);
		button.click();
	}
	expect(refresh).not.toHaveBeenCalled();
});

async function openSortMenu(trigger: HTMLElement): Promise<void> {
	await fireEvent.pointerDown(trigger, {
		button: 0,
		ctrlKey: false,
		pointerType: 'mouse',
	});
}

async function chooseSortOrder(trigger: HTMLElement, label: string): Promise<void> {
	await openSortMenu(trigger);
	await fireEvent.click(await screen.findByRole('menuitemradio', { name: label }));
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

	it('shows a reopened picker as busy until the pending creation settles, not as empty', async () => {
		const view = renderPicker([], { isCreating: true });
		const list = screen.getByRole('listbox', { name: 'Select worktree' });
		expect(list.getAttribute('aria-busy')).toBe('true');
		expect(screen.queryByText('No worktrees found')).toBeNull();

		await view.rerender({ isCreating: false, catalogContextKey: null });
		expect(screen.getByRole('status').textContent).toContain('Executor unavailable');
		expect(screen.queryByText('No worktrees found')).toBeNull();
		await view.rerender({ catalogContextKey: 'ready', worktrees: [worktree('main', null)] });
		expect(list.getAttribute('aria-busy')).toBe('false');
		expect(screen.getByRole('option', { name: /main/ })).toBeTruthy();
	});

	it('uses mobile-safe input text and compact two-line row metadata', () => {
		renderPicker([worktree('mobile', '2026-07-15T10:00:00.000Z')]);

		const filter = screen.getByRole('combobox', { name: 'Filter worktrees' });
		expect(filter.className).toContain('text-base');
		expect(filter.className).toContain('md:text-base');
		expect(filter.className).not.toMatch(/(?:^|\s)text-sm(?:\s|$)/);
		expect(filter.className).not.toContain('md:text-sm');

		const timestamp = screen.getByRole('time');
		const path = screen.getByText('/workspace/mobile');
		expect(timestamp.className).toContain('text-xs');
		expect(timestamp.parentElement?.nextElementSibling).toBe(path);
		expect(path.title).toBe('/workspace/mobile');
	});

	it('labels the repository worktree without conflating it with a main branch', () => {
		renderPicker([
			worktree('repository', '2026-07-15T10:00:00.000Z', {
				branch: 'main',
				isMain: true,
			}),
		]);

		const option = screen.getByRole('option', { name: /main/ });
		expect(option.textContent).toContain('repo');
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
		const select = vi.fn();
		const items = Array.from({ length: 120 }, (_, index) =>
			worktree(`worktree-${index.toString().padStart(3, '0')}`, '2026-07-15T10:00:00.000Z'),
		);
		renderPicker(items, { select });
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

		expect(select).toHaveBeenCalledWith('/workspace/worktree-000');
	});

	it('does not select an offscreen option after manual virtual-list scrolling', async () => {
		const select = vi.fn();
		const items = Array.from({ length: 120 }, (_, index) =>
			worktree(`worktree-${index.toString().padStart(3, '0')}`, '2026-07-15T10:00:00.000Z'),
		);
		renderPicker(items, { select });
		const filter = screen.getByRole('combobox', { name: 'Filter worktrees' });
		const viewport = screen.getByRole('listbox', { name: 'Select worktree' });

		viewport.scrollTop = 80 * 60;
		await fireEvent.scroll(viewport);
		await waitFor(() => {
			expect(filter.getAttribute('aria-activedescendant')).toBeNull();
			expect(screen.queryByRole('option', { name: /worktree-000/ })).toBeNull();
		});

		await fireEvent.keyDown(filter, { key: 'Enter' });
		expect(select).not.toHaveBeenCalled();
	});

	it('keeps a deep virtual selection mounted after returning from the create form', async () => {
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
			await fireEvent.click(screen.getByRole('button', { name: 'Back' }));
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

	it('offers a compact checked sort menu with item icons and applies alphabetical ordering', async () => {
		renderPicker([
			worktree('alpha', '2026-07-13T10:00:00.000Z'),
			worktree('beta', '2026-07-15T10:00:00.000Z'),
		]);
		const sort = screen.getByRole('button', { name: 'Sort worktrees' });
		expect(sort.className).toContain('h-8');
		expect(sort.className).toContain('w-8');

		await openSortMenu(sort);
		const ascending = await screen.findByRole('menuitemradio', {
			name: 'Alphabetical (ascending)',
		});
		const descending = screen.getByRole('menuitemradio', {
			name: 'Alphabetical (descending)',
		});
		const modified = screen.getByRole('menuitemradio', { name: 'Last Modified Time' });
		expect(ascending.getAttribute('aria-checked')).toBe('false');
		expect(descending.getAttribute('aria-checked')).toBe('false');
		expect(modified.getAttribute('aria-checked')).toBe('true');
		expect(ascending.querySelector('svg')).toBeTruthy();
		expect(descending.querySelector('svg')).toBeTruthy();
		expect(modified.querySelectorAll('svg')).toHaveLength(2);

		await fireEvent.click(modified);
		expect(renderedWorktreeNames()).toEqual(['beta', 'alpha']);

		await chooseSortOrder(sort, 'Alphabetical (ascending)');
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
		renderPicker([], { loadError: 'Unable to load worktrees' });

		expect(screen.getByText('Unable to load worktrees')).toBeTruthy();
		expect(screen.queryByText('No matching worktrees')).toBeNull();
	});

	it('shows creation failures in the form, not an earlier list error', async () => {
		const view = renderPicker([worktree('main', null, { isMain: true })], {
			loadError: 'Refresh failed',
		});
		await fireEvent.click(screen.getByRole('button', { name: 'New worktree' }));
		expect(screen.queryByRole('alert')).toBeNull();
		await fireEvent.input(screen.getByRole('textbox', { name: /branch name/i }), {
			target: { value: 'existing-path' },
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Create worktree' }));
		await view.rerender({ createResult: { error: 'Destination already exists' } });
		expect(screen.getByRole('alert').textContent).toBe('Destination already exists');
		expect(screen.getByDisplayValue('existing-path')).toBeTruthy();
	});

	it('selects the effective filtered row with Enter and navigates with arrow keys', async () => {
		const select = vi.fn();
		renderPicker(
			[worktree('one', '2026-07-15T10:00:00.000Z'), worktree('two', '2026-07-14T10:00:00.000Z')],
			{ select },
		);
		const filter = screen.getByRole('combobox', { name: 'Filter worktrees' });
		const initialActiveOption = filter.getAttribute('aria-activedescendant');

		await fireEvent.keyDown(filter, { key: 'ArrowDown' });
		expect(filter.getAttribute('aria-activedescendant')).not.toBe(initialActiveOption);
		await fireEvent.keyDown(filter, { key: 'Enter' });
		expect(select).toHaveBeenCalledWith('/workspace/two');

		select.mockClear();
		await fireEvent.input(filter, { target: { value: 'one' } });
		await fireEvent.keyDown(filter, { key: 'Enter' });
		expect(select).toHaveBeenCalledWith('/workspace/one');
	});

	it('changes the effective row only after actual pointer movement', async () => {
		const select = vi.fn();
		renderPicker(
			[worktree('one', '2026-07-15T10:00:00.000Z'), worktree('two', '2026-07-14T10:00:00.000Z')],
			{ select },
		);
		const filter = screen.getByRole('combobox', { name: 'Filter worktrees' });
		const [, secondOption] = screen.getAllByRole('option');

		await fireEvent.mouseEnter(secondOption);
		await fireEvent.keyDown(filter, { key: 'Enter' });
		expect(select).toHaveBeenLastCalledWith('/workspace/one');

		await fireEvent.mouseMove(secondOption);
		await fireEvent.keyDown(filter, { key: 'Enter' });
		expect(select).toHaveBeenLastCalledWith('/workspace/two');
	});

	it('does not select when IME composition confirms with Enter', async () => {
		const select = vi.fn();
		renderPicker([worktree('selectable', '2026-07-15T10:00:00.000Z')], { select });
		const filter = screen.getByRole('combobox', { name: 'Filter worktrees' });

		await fireEvent.keyDown(filter, { key: 'Enter', isComposing: true });
		expect(select).not.toHaveBeenCalled();

		await fireEvent.keyDown(filter, { key: 'Enter' });
		expect(select).toHaveBeenCalledWith('/workspace/selectable');
	});

	it('does not select for Safari IME confirmation key events', async () => {
		const select = vi.fn();
		renderPicker([worktree('selectable', '2026-07-15T10:00:00.000Z')], { select });
		const filter = screen.getByRole('combobox', { name: 'Filter worktrees' });

		await fireEvent.keyDown(filter, { key: 'Enter', keyCode: 229 });
		expect(select).not.toHaveBeenCalled();
	});

	it('does not treat sort keyboard events as worktree selection', async () => {
		const select = vi.fn();
		renderPicker([worktree('selectable', '2026-07-15T10:00:00.000Z')], { select });
		const sort = screen.getByRole('button', { name: 'Sort worktrees' });

		await fireEvent.keyDown(sort, { key: 'Enter' });
		expect(select).not.toHaveBeenCalled();
	});

	it('closes the sort menu with Escape without closing the picker', async () => {
		const close = vi.fn();
		renderPicker([worktree('selectable', '2026-07-15T10:00:00.000Z')], { close });
		const sort = screen.getByRole('button', { name: 'Sort worktrees' });

		await openSortMenu(sort);
		const option = await screen.findByRole('menuitemradio', {
			name: 'Alphabetical (ascending)',
		});
		await fireEvent.keyDown(option, { key: 'Escape' });

		await waitFor(() =>
			expect(
				screen.queryByRole('menuitemradio', { name: 'Alphabetical (ascending)' }),
			).toBeNull(),
		);
		expect(close).not.toHaveBeenCalled();
		expect(screen.getByRole('combobox', { name: 'Filter worktrees' })).toBeTruthy();
	});

	it('does not select an unavailable result with Enter', async () => {
		const select = vi.fn();
		renderPicker([worktree('missing', null, { isPathMissing: true })], { select });
		const filter = screen.getByRole('combobox', { name: 'Filter worktrees' });

		await fireEvent.keyDown(filter, { key: 'Enter' });
		expect(select).not.toHaveBeenCalled();
	});

	it('does not expose or select stale options while loading', async () => {
		const select = vi.fn();
		const view = renderPicker([worktree('stale', '2026-07-15T10:00:00.000Z')], {
			select,
		});
		const filter = screen.getByRole('combobox', { name: 'Filter worktrees' });

		await view.rerender({ isLoading: true });
		expect(filter.getAttribute('aria-activedescendant')).toBeNull();
		expect(screen.getByRole('listbox', { name: 'Select worktree' }).getAttribute('aria-busy')).toBe(
			'true',
		);
		await fireEvent.keyDown(filter, { key: 'Enter' });
		expect(select).not.toHaveBeenCalled();
	});

	it('shows compact modification labels with exact tooltips and an unavailable state', () => {
		const timestamp = new Date(Date.now() - 2 * 60 * 60 * 1_000).toISOString();
		const expected = formatRelativeTimestamp(timestamp, new Date());
		renderPicker([worktree('recent', timestamp), worktree('unknown', null)]);

		const time = screen.getByText(expected?.label ?? '');
		expect(time.getAttribute('title')).toBe(expected?.tooltip);
		expect(screen.getByText('Unavailable').getAttribute('title')).toBe(
			'Last modified time unavailable',
		);
	});

	it('shows the confirmed path without offering to submit the completed draft again', async () => {
		const create = vi.fn();
		const view = renderPicker([worktree('main', null, { isMain: true })], { create });
		await fireEvent.click(screen.getByRole('button', { name: 'New worktree' }));
		const field = screen.getByRole<HTMLInputElement>('textbox', { name: /branch name/i });
		await fireEvent.input(field, { target: { value: 'feature' } });
		const submit = screen.getByRole<HTMLButtonElement>('button', { name: 'Create worktree' });
		await fireEvent.click(submit);
		await view.rerender({ createResult: { createdPath: '/canonical' } });
		expect(screen.getByRole('status').textContent).toBe('Worktree created at /canonical.');
		expect(submit.getAttribute('aria-disabled')).toBe('true');
		await fireEvent.click(submit);
		await fireEvent.keyDown(field, { key: 'Enter' });
		expect(create).toHaveBeenCalledTimes(1);
		await fireEvent.click(screen.getByRole('button', { name: 'Back' }));
		expect(screen.getByRole('dialog', { name: 'Select worktree' })).toBeTruthy();
		await fireEvent.click(screen.getByRole('button', { name: 'New worktree' }));
		expect(screen.queryByText('Worktree created at /canonical.')).toBeNull();
		expect(screen.getByRole<HTMLInputElement>('textbox', { name: /branch name/i }).readOnly).toBe(false);
	});

	it('uses the current render time for worktrees returned by refresh', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date('2026-07-15T10:00:00.000Z'));
		const view = renderPicker([worktree('old', '2026-07-15T09:00:00.000Z')]);

		vi.setSystemTime(new Date('2026-07-15T10:05:00.000Z'));
		await view.rerender({
			worktrees: [worktree('refreshed', '2026-07-15T10:05:00.000Z')],
		});

		expect(screen.getByText('now')).toBeTruthy();
	});

	it('renders malformed server timestamps as unavailable', () => {
		renderPicker([worktree('malformed', '2026-02-30T10:00:00.000Z')]);

		expect(screen.getByText('Unavailable')).toBeTruthy();
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
		await openSortMenu(screen.getByRole('button', { name: 'Sort worktrees' }));
		expect(
			(
				await screen.findByRole('menuitemradio', { name: 'Alphabetical (descending)' })
			).getAttribute('aria-checked'),
		).toBe('true');
		expect(renderedWorktreeNames()).toEqual(['gamma', 'alpha']);
	});

	it('falls back to the first selectable row when refresh removes the selection', async () => {
		const select = vi.fn();
		const view = renderPicker(
			[
				worktree('newer', '2026-07-15T10:00:00.000Z'),
				worktree('older', '2026-07-14T10:00:00.000Z'),
			],
			{ select },
		);
		const filter = screen.getByRole('combobox', { name: 'Filter worktrees' });
		await fireEvent.keyDown(filter, { key: 'ArrowDown' });

		await view.rerender({
			worktrees: [worktree('replacement', '2026-07-16T10:00:00.000Z')],
		});
		await fireEvent.keyDown(filter, { key: 'Enter' });

		expect(select).toHaveBeenCalledWith('/workspace/replacement');
	});

	it('keeps create-form Enter and Escape behavior separate from worktree selection', async () => {
		const create = vi.fn();
		const select = vi.fn();
		const close = vi.fn();
		renderPicker(
			[
				worktree('main', '2026-07-15T10:00:00.000Z', {
					path: '/workspace/repo',
					isMain: true,
				}),
			],
			{
				create,
				select,
				close,
			},
		);

		await fireEvent.click(screen.getByRole('button', { name: 'New worktree' }));
		const branchInput = screen.getByPlaceholderText('Branch name (e.g. fix/login-bug)');
		expect(document.activeElement).toBe(branchInput);
		await fireEvent.input(branchInput, { target: { value: 'feature/search' } });
		await fireEvent.keyDown(branchInput, { key: 'Enter' });
		expect(create).toHaveBeenCalledWith({ worktreePath: '/workspace/repo/.worktrees/feature-search', branch: 'feature/search', baseRef: undefined });
		expect(select).not.toHaveBeenCalled();

		await fireEvent.keyDown(branchInput, { key: 'Escape' });
		expect(screen.queryByPlaceholderText('Branch name (e.g. fix/login-bug)')).toBeNull();
		expect(close).not.toHaveBeenCalled();
		await waitFor(() =>
			expect(document.activeElement).toBe(
				screen.getByRole('combobox', { name: 'Filter worktrees' }),
			),
		);
	});

	it('derives new worktrees from the repository worktree when opened from a linked worktree', async () => {
		const create = vi.fn();
		renderPicker(
			[
				worktree('repo', '2026-07-15T10:00:00.000Z', {
					path: '/repo',
					branch: 'main',
					isMain: true,
				}),
				worktree('example', '2026-07-16T10:00:00.000Z', {
					path: '/repo/.worktrees/example',
					isCurrent: true,
				}),
			],
			{ create },
		);

		await fireEvent.click(screen.getByRole('button', { name: 'New worktree' }));
		await fireEvent.input(screen.getByPlaceholderText('Branch name (e.g. fix/login-bug)'), {
			target: { value: 'example2' },
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Create worktree' }));

		expect(create).toHaveBeenCalledWith({ worktreePath: '/repo/.worktrees/example2', branch: 'example2', baseRef: undefined });
	});

	it('requires repository metadata for a default path but permits an explicit override', async () => {
		const create = vi.fn();
		const view = renderPicker(
			[
				worktree('example', '2026-07-16T10:00:00.000Z', {
					path: '/repo/.worktrees/example',
					isCurrent: true,
				}),
			],
			{ create },
		);

		await fireEvent.click(screen.getByRole('button', { name: 'New worktree' }));
		await fireEvent.input(screen.getByPlaceholderText('Branch name (e.g. fix/login-bug)'), {
			target: { value: 'example2' },
		});
		const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Create worktree' });
		expect(button.getAttribute('aria-disabled')).toBe('true');
		await fireEvent.click(button);
		expect(create).not.toHaveBeenCalled();

		await fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
		const location = screen.getByLabelText<HTMLInputElement>('Location');
		expect(location.placeholder).toBe('Path override');
		await fireEvent.input(location, { target: { value: '/tmp/example2 ' } });
		await fireEvent.click(button);
		expect(create).toHaveBeenLastCalledWith({
			worktreePath: '/tmp/example2 ', branch: 'example2', baseRef: undefined,
		});

		await fireEvent.input(location, { target: { value: '   ' } });
		expect(button.getAttribute('aria-disabled')).toBe('true');
		await view.rerender({ worktrees: [worktree('repo', null, { path: '/repo ', isMain: true })] });
		expect(location.placeholder).toBe('/repo /.worktrees/example2');
		await fireEvent.click(button);
		expect(create).toHaveBeenLastCalledWith({
			worktreePath: '/repo /.worktrees/example2', branch: 'example2', baseRef: undefined,
		});
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

	it('requests a suggestion only on click and creates it only on explicit submission', async () => {
		const create = vi.fn();
		const response = Promise.withResolvers<{ name: string }>();
		vi.mocked(generateGitName).mockReturnValueOnce(response.promise);
		renderPicker([worktree('main', null, { isMain: true })], { create, description: 'Improve picker' });
		await fireEvent.click(screen.getByRole('button', { name: 'New worktree' }));
		const field = screen.getByRole<HTMLInputElement>('textbox', { name: /branch name/i });
		expect(field.value).toBe('');
		expect(generateGitName).not.toHaveBeenCalled();
		await fireEvent.click(screen.getByRole('button', { name: 'Generate name' }));
		expect(generateGitName).toHaveBeenCalledExactlyOnceWith({ description: 'Improve picker', previousName: '' }, expect.any(AbortSignal));
		response.resolve({ name: 'picker-polish' });
		await waitFor(() => expect(field.value).toBe('picker-polish'));
		await fireEvent.keyDown(field, { key: 'Enter', isComposing: true });
		expect(create).not.toHaveBeenCalled();
		await fireEvent.keyDown(field, { key: 'Enter' });
		expect(create).toHaveBeenCalledWith({ worktreePath: '/workspace/main/.worktrees/picker-polish', newBranch: 'picker-polish', baseRef: undefined });
		await fireEvent.input(field, { target: { value: 'manual' } });
		await fireEvent.keyDown(field, { key: 'Enter' });
		expect(create).toHaveBeenLastCalledWith({ worktreePath: '/workspace/main/.worktrees/manual', branch: 'manual', baseRef: undefined });
	});

	it('retains naming work offline and shows only the submitted creation result', async () => {
		const response = Promise.withResolvers<{ name: string }>();
		vi.mocked(generateGitName).mockReturnValueOnce(response.promise);
		const create = vi.fn();
		const view = renderPicker([worktree('main', null, { isMain: true })], {
			contextKey: 'worker/repo', catalogContextKey: 'serving-1', create,
		});
		await fireEvent.click(screen.getByRole('button', { name: 'New worktree' }));
		const field = screen.getByRole<HTMLInputElement>('textbox', { name: /branch name/i });
		await fireEvent.click(screen.getByRole('button', { name: 'Generate name' }));
		const request = vi.mocked(generateGitName).mock.lastCall![1];
		await view.rerender({ catalogContextKey: null });
		expect(screen.getByRole('textbox', { name: /branch name/i })).toBe(field);
		expect(request.aborted).toBe(false);
		response.resolve({ name: 'stable-draft' });
		await waitFor(() => expect(field.value).toBe('stable-draft'));
		await fireEvent.keyDown(field, { key: 'Enter' });
		expect(create).not.toHaveBeenCalled();
		await view.rerender({ catalogContextKey: 'serving-2' });
		await fireEvent.keyDown(field, { key: 'Enter' });
		expect(create).toHaveBeenCalledTimes(1);
		await view.rerender({ isCreating: true, catalogContextKey: null });
		await view.rerender({ catalogContextKey: 'serving-3' });
		await fireEvent.keyDown(field, { key: 'Enter' });
		expect(create).toHaveBeenCalledTimes(1);
		await view.rerender({ isCreating: false, createResult: { error: 'Outcome unknown' } });
		await view.rerender({ loadError: 'Catalog unavailable' });
		expect(screen.getByRole('alert').textContent).toBe('Outcome unknown');
		expect(screen.getByDisplayValue('stable-draft')).toBe(field);
	});

	it.each(['edit', 'back', 'executor', 'description'] as const)('discards a pending suggestion after %s', async (transition) => {
		const response = Promise.withResolvers<{ name: string }>();
		vi.mocked(generateGitName).mockReturnValueOnce(response.promise);
		const view = renderPicker([worktree('main', null, { isMain: true })], { contextKey: 'worker-A' });
		await fireEvent.click(screen.getByRole('button', { name: 'New worktree' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Generate name' }));
		const signal = vi.mocked(generateGitName).mock.lastCall![1];
		if (transition === 'edit') await fireEvent.input(screen.getByRole('textbox'), { target: { value: 'typed' } });
		if (transition === 'back') await fireEvent.click(screen.getByRole('button', { name: 'Back' }));
		if (transition === 'description') await view.rerender({ description: 'Changed task' });
		if (transition === 'executor') {
			await view.rerender({ contextKey: 'worker-B' });
			await view.rerender({ contextKey: 'worker-A' });
			expect(screen.queryByRole('dialog', { name: 'New worktree' })).toBeNull();
		}
		expect(signal.aborted).toBe(true);
		response.resolve({ name: 'late-answer' });
		await response.promise;
		expect(screen.queryByDisplayValue('late-answer')).toBeNull();
		if (transition === 'edit') expect(screen.getByDisplayValue('typed')).toBeTruthy();
	});

	it('keeps manual creation and its overrides available when generation fails', async () => {
		const create = vi.fn();
		vi.mocked(generateGitName).mockRejectedValueOnce(new Error('Model unavailable'));
		renderPicker([worktree('main', null, { isMain: true })], { create });
		await fireEvent.click(screen.getByRole('button', { name: 'New worktree' }));
		const field = screen.getByRole('textbox', { name: /branch name/i });
		await fireEvent.input(field, { target: { value: 'release/preview' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
		await fireEvent.input(screen.getByLabelText('Location'), { target: { value: '/repo/custom' } });
		await fireEvent.input(screen.getByLabelText('Base ref'), { target: { value: 'v2' } });
		expect(generateGitName).not.toHaveBeenCalled();
		await fireEvent.click(screen.getByRole('button', { name: 'Generate name' }));
		expect((await screen.findByRole('alert')).textContent).toContain('type a name');
		await fireEvent.click(screen.getByRole('button', { name: 'Create worktree' }));
		expect(create).toHaveBeenCalledWith({
			worktreePath: '/repo/custom', branch: 'release/preview', baseRef: 'v2',
		});
	});

	it('discards the create draft on Back and returns to the same filter', async () => {
		const select = vi.fn();
		const create = vi.fn();
		renderPicker([worktree('feature', null)], { select, create });
		const filter = screen.getByRole('combobox');
		await fireEvent.input(filter, { target: { value: 'feat' } });
		await fireEvent.click(screen.getByRole('button', { name: 'New worktree' }));
		expect(screen.queryByRole('combobox')).toBeNull();
		expect(screen.queryByRole('button', { name: 'Sort worktrees' })).toBeNull();
		await fireEvent.input(screen.getByRole('textbox'), { target: { value: 'draft' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
		await fireEvent.input(screen.getByLabelText('Location'), { target: { value: '/old' } });
		await fireEvent.input(screen.getByLabelText('Base ref'), { target: { value: 'main' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Back' }));
		await waitFor(() => expect(document.activeElement).toBe(filter));
		expect(screen.getByDisplayValue('feat')).toBe(filter);
		expect(select).not.toHaveBeenCalled();
		expect(create).not.toHaveBeenCalled();

		await fireEvent.click(screen.getByRole('button', { name: 'New worktree' }));
		expect(screen.getByRole<HTMLInputElement>('textbox').value).toBe('');
		expect(screen.queryByLabelText('Location')).toBeNull();
		await fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
		expect(screen.getByLabelText<HTMLInputElement>('Location').value).toBe('');
		expect(screen.getByLabelText<HTMLInputElement>('Base ref').value).toBe('');
	});
});
