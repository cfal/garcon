import type { ComponentProps } from 'svelte';
import type GitWorktreePickerModal from '../GitWorktreePickerModal.svelte';

export type PickerPort = ComponentProps<typeof GitWorktreePickerModal>['session'];

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
