import type { ComponentProps } from 'svelte';
import type { GitWorktreeItem } from '$lib/api/git.js';
import type GitWorktreePickerModal from '../GitWorktreePickerModal.svelte';

export type PickerPort = ComponentProps<typeof GitWorktreePickerModal>['session'];

export function worktree(
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

export function pickerFixture(overrides: Partial<PickerPort>): PickerPort {
	return {
		contextKey: 'local/repo',
		catalogContextKey: 'ready',
		worktrees: [],
		isCreating: false,
		isLoading: false,
		loadError: null,
		createResult: null,
		get canRefresh() { return this.catalogContextKey !== null && !this.isCreating && !this.isLoading; },
		get canUseGit() { return this.canRefresh; },
		syncCatalog: async () => {},
		refresh: async () => {},
		create: async () => {},
		select: () => {},
		close: () => {},
		...overrides,
	};
}
