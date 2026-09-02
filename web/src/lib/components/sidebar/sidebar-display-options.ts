import type {
	SidebarChatGrouping,
	SidebarChatItemLayout,
	SidebarSortMode,
} from '$lib/stores/local-settings.svelte';

export interface SidebarDisplayOptions {
	grouping: SidebarChatGrouping;
	groupNestedProjectPaths: boolean;
	chatItemLayout: SidebarChatItemLayout;
	sortMode: SidebarSortMode;
}

export const DEFAULT_SIDEBAR_DISPLAY_OPTIONS: SidebarDisplayOptions = {
	grouping: 'project',
	groupNestedProjectPaths: false,
	chatItemLayout: 'default',
	sortMode: 'manual',
};
