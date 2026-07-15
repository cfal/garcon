import { describe, expect, it } from 'vitest';
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
			worktree('newer', '2026-07-15T10:00:00.000Z'),
		];

		expect(
			filterAndSortWorktrees(source, '', 'last-modified', 'en').map((item) => item.name),
		).toEqual(['newer', 'older', 'invalid', 'missing']);
		expect(source.map((item) => item.name)).toEqual(['missing', 'older', 'invalid', 'newer']);
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
});
