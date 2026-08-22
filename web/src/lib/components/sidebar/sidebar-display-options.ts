import type { SidebarChatItemLayout, SidebarSortMode } from '$lib/stores/local-settings.svelte';

export interface SidebarDisplayOptions {
	groupByProject: boolean;
	groupNestedProjectPaths: boolean;
	chatItemLayout: SidebarChatItemLayout;
	sortMode: SidebarSortMode;
}

export const DEFAULT_SIDEBAR_DISPLAY_OPTIONS: SidebarDisplayOptions = {
	groupByProject: true,
	groupNestedProjectPaths: false,
	chatItemLayout: 'default',
	sortMode: 'manual',
};
