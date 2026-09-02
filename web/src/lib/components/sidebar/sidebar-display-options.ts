import type {
	SidebarChatGrouping,
	SidebarChatItemLayout,
	SidebarInactivityDuration,
	SidebarSortMode,
} from '$lib/stores/local-settings.svelte';

export interface SidebarDisplayOptions {
	grouping: SidebarChatGrouping;
	inactivityDuration: SidebarInactivityDuration;
	groupNestedProjectPaths: boolean;
	chatItemLayout: SidebarChatItemLayout;
	sortMode: SidebarSortMode;
}

export const DEFAULT_SIDEBAR_DISPLAY_OPTIONS: SidebarDisplayOptions = {
	grouping: 'project',
	inactivityDuration: '3-days',
	groupNestedProjectPaths: false,
	chatItemLayout: 'default',
	sortMode: 'manual',
};

export function sidebarGroupingUsesProjects(grouping: SidebarChatGrouping): boolean {
	return grouping === 'project' || grouping === 'project-and-activity';
}
