import { describe, expect, it, vi } from 'vitest';
import type { GitWorktreeItem } from '$lib/api/git.js';
import {
	filterAndSortWorktrees,
	GitWorktreePickerState,
	isWorktreeSortOrder,
} from '../git-worktree-picker-state.svelte.js';

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

function pickerFor(getWorktrees: () => GitWorktreeItem[]): GitWorktreePickerState {
	return new GitWorktreePickerState({
		get worktrees() {
			return getWorktrees();
		},
		get locale() {
			return 'en';
		},
	});
}

describe('filterAndSortWorktrees', () => {
	it('orders newest first and sends missing or invalid timestamps to the end', () => {
		const source = [
			worktree('missing', null),
			worktree('older', '2026-07-13T10:00:00.000Z'),
			worktree('invalid', 'not-a-date'),
			worktree('noncanonical', '2026-07-15'),
			worktree('overflow', '2026-02-30T10:00:00.000Z'),
			worktree('newer', '2026-07-15T10:00:00.000Z'),
		];

		expect(
			filterAndSortWorktrees(source, '', 'last-modified', 'en').map((item) => item.name),
		).toEqual(['newer', 'older', 'invalid', 'missing', 'noncanonical', 'overflow']);
		expect(source.map((item) => item.name)).toEqual([
			'missing',
			'older',
			'invalid',
			'noncanonical',
			'overflow',
			'newer',
		]);
	});

	it('uses deterministic numeric alphabetical ordering in both directions', () => {
		const source = [
			worktree('Feature 10', '2026-07-15T10:00:00.000Z'),
			worktree('feature 2', '2026-07-15T10:00:00.000Z'),
			worktree('Alpha', '2026-07-15T10:00:00.000Z'),
		];

		expect(
			filterAndSortWorktrees(source, '', 'alphabetical-ascending', 'en').map((item) => item.name),
		).toEqual(['Alpha', 'feature 2', 'Feature 10']);
		expect(
			filterAndSortWorktrees(source, '', 'alphabetical-descending', 'en').map((item) => item.name),
		).toEqual(['Feature 10', 'feature 2', 'Alpha']);
	});

	it('uses the path as a deterministic tie-break and treats whitespace as an empty filter', () => {
		const timestamp = '2026-07-15T10:00:00.000Z';
		const source = [
			worktree('same', timestamp, { path: '/workspace/zeta' }),
			worktree('same', timestamp, { path: '/workspace/alpha' }),
		];

		expect(
			filterAndSortWorktrees(source, '   ', 'last-modified', 'en').map((item) => item.path),
		).toEqual(['/workspace/alpha', '/workspace/zeta']);
	});

	it('filters case-insensitive substrings across name, branch, and path basename', () => {
		const source = [
			worktree('display-name', null, { branch: 'feature/search' }),
			worktree('named-match', null, { branch: 'other', path: '/workspace/unrelated' }),
			worktree('windows', null, { branch: 'other', path: 'C:\\repos\\ClientPortal' }),
		];

		expect(filterAndSortWorktrees(source, 'SEARCH', 'alphabetical-ascending', 'en')).toEqual([
			source[0],
		]);
		expect(filterAndSortWorktrees(source, 'ed-ma', 'alphabetical-ascending', 'en')).toEqual([
			source[1],
		]);
		expect(filterAndSortWorktrees(source, 'portal', 'alphabetical-ascending', 'en')).toEqual([
			source[2],
		]);
	});

	it('parses each timestamp once when sorting five thousand worktrees', () => {
		const source = Array.from({ length: 5_000 }, (_, index) =>
			worktree(
				`worktree-${index}`,
				new Date(Date.UTC(2026, 0, 1, 0, 0, index % 60, index % 1_000)).toISOString(),
			),
		).reverse();
		const parse = vi.spyOn(Date, 'parse');

		const result = filterAndSortWorktrees(source, '', 'last-modified', 'en');

		expect(parse).toHaveBeenCalledTimes(source.length);
		expect(result).toHaveLength(source.length);
		parse.mockRestore();
	});
});

describe('GitWorktreePickerState', () => {
	it('defaults to recent order and navigates only visible selectable worktrees', () => {
		const items = [
			worktree('old', '2026-07-13T10:00:00.000Z'),
			worktree('missing', '2026-07-16T10:00:00.000Z', { isPathMissing: true }),
			worktree('new', '2026-07-15T10:00:00.000Z'),
		];
		const picker = pickerFor(() => items);

		expect(picker.sortOrder).toBe('last-modified');
		expect(picker.visibleWorktrees.map((item) => item.name)).toEqual(['missing', 'new', 'old']);
		expect(picker.selectedWorktree?.name).toBe('new');

		picker.moveSelection(1);
		expect(picker.selectedWorktree?.name).toBe('old');
		picker.moveSelection(-1);
		expect(picker.selectedWorktree?.name).toBe('new');
		picker.moveSelection(-1);
		expect(picker.selectedWorktree?.name).toBe('new');
		picker.selectPath('/workspace/old');
		picker.moveSelection(1);
		expect(picker.selectedWorktree?.name).toBe('old');
	});

	it('retains a selected path across sorting and falls back after filtering or refresh', () => {
		let items = [
			worktree('alpha', '2026-07-13T10:00:00.000Z'),
			worktree('beta', '2026-07-15T10:00:00.000Z'),
		];
		const picker = pickerFor(() => items);

		picker.selectPath('/workspace/alpha');
		picker.setSortOrder('alphabetical-descending');
		expect(picker.selectedWorktree?.name).toBe('alpha');

		picker.filterQuery = 'beta';
		expect(picker.selectedWorktree?.name).toBe('beta');

		picker.filterQuery = '';
		items = [worktree('gamma', '2026-07-16T10:00:00.000Z')];
		expect(picker.selectedWorktree?.name).toBe('gamma');
	});

	it('has no effective selection when every visible row is missing', () => {
		const picker = pickerFor(() => [worktree('missing', null, { isPathMissing: true })]);

		expect(picker.selectedWorktree).toBeNull();
		expect(picker.selectedIndex).toBe(-1);
		picker.moveSelection(1);
		expect(picker.selectedPath).toBeNull();
	});

	it('has no effective selection when a filter matches only missing rows', () => {
		const picker = pickerFor(() => [
			worktree('available', '2026-07-15T10:00:00.000Z'),
			worktree('hidden-missing', null, { isPathMissing: true }),
		]);

		picker.filterQuery = 'hidden-missing';
		expect(picker.visibleWorktrees.map((item) => item.name)).toEqual(['hidden-missing']);
		expect(picker.selectedWorktree).toBeNull();
		expect(picker.selectedIndex).toBe(-1);
	});

	it('preserves the existing create form derivation and reset behavior', () => {
		const picker = pickerFor(() => []);
		picker.showCreateForm = true;
		picker.branchName = 'feature/search';
		picker.showAdvanced = true;
		picker.pathOverride = '/tmp/search';
		picker.baseRefOverride = 'main';

		expect(picker.derivedPath).toBe('../.worktrees/feature-search');
		expect(picker.effectivePath).toBe('/tmp/search');
		expect(picker.canCreate).toBe(true);

		picker.resetCreateForm();
		expect(picker.showCreateForm).toBe(false);
		expect(picker.branchName).toBe('');
		expect(picker.showAdvanced).toBe(false);
		expect(picker.pathOverride).toBe('');
		expect(picker.baseRefOverride).toBe('');
	});

	it('accepts only supported sort order values', () => {
		expect(isWorktreeSortOrder('last-modified')).toBe(true);
		expect(isWorktreeSortOrder('creation-time')).toBe(false);
	});

	it('does not rescan the list when pointer movement repeats the selected path', () => {
		const first = worktree('first', null);
		const picker = pickerFor(() => [first]);
		picker.selectPath(first.path);
		const some = vi.spyOn(Array.prototype, 'some');

		picker.selectPath(first.path);

		expect(some).not.toHaveBeenCalled();
		some.mockRestore();
	});
});
