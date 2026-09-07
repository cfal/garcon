import type {
	SidebarChatGrouping,
	SidebarChatItemLayout,
	SidebarInactivityDuration,
	SidebarSortMode,
} from '$lib/stores/local-settings.svelte';
import type { PinnedInsertPosition } from '$shared/settings';

export interface SidebarDisplayOptions {
	grouping: SidebarChatGrouping;
	inactivityDuration: SidebarInactivityDuration;
	groupNestedProjectPaths: boolean;
	chatItemLayout: SidebarChatItemLayout;
	sortMode: SidebarSortMode;
	pinnedInsertPosition: PinnedInsertPosition;
}

export const DEFAULT_SIDEBAR_DISPLAY_OPTIONS: SidebarDisplayOptions = {
	grouping: 'project-and-activity',
	inactivityDuration: '3-days',
	groupNestedProjectPaths: false,
	chatItemLayout: 'compact',
	sortMode: 'manual',
	pinnedInsertPosition: 'top',
};

export function sidebarGroupingUsesProjects(grouping: SidebarChatGrouping): boolean {
	return grouping === 'project' || grouping === 'project-and-activity';
}
