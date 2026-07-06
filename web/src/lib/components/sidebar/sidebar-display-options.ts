import type { SidebarSortMode } from '$lib/stores/local-settings.svelte';

export interface SidebarDisplayOptions {
	groupByProject: boolean;
	groupNestedProjectPaths: boolean;
	compactChatItems: boolean;
	sortMode: SidebarSortMode;
}

export const DEFAULT_SIDEBAR_DISPLAY_OPTIONS: SidebarDisplayOptions = {
	groupByProject: true,
	groupNestedProjectPaths: false,
	compactChatItems: false,
	sortMode: 'manual',
};
