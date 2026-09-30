import type {
	SidebarChatGrouping,
	SidebarInactivityDuration,
	SidebarSortMode,
} from '$lib/stores/local-settings.svelte';
import type { ChatItemLayout } from '$lib/layout/chat-item-layout.js';
import type { PinnedInsertPosition } from '$shared/settings';

export interface SidebarDisplayOptions {
	grouping: SidebarChatGrouping;
	inactivityDuration: SidebarInactivityDuration;
	groupNestedProjectPaths: boolean;
	chatItemLayout: ChatItemLayout;
	showProjectPath: boolean;
	sortMode: SidebarSortMode;
	pinnedInsertPosition: PinnedInsertPosition;
}

export const DEFAULT_SIDEBAR_DISPLAY_OPTIONS: SidebarDisplayOptions = {
	grouping: 'project-and-activity',
	inactivityDuration: '3-days',
	groupNestedProjectPaths: false,
	chatItemLayout: 'single-line',
	showProjectPath: false,
	sortMode: 'manual',
	pinnedInsertPosition: 'top',
};

export function sidebarGroupingUsesProjects(grouping: SidebarChatGrouping): boolean {
	return grouping === 'project' || grouping === 'project-and-activity';
}
