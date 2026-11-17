import type {
	LocalSettingsSnapshot,
	SidebarInactivityDuration,
	SidebarSortMode,
} from '$lib/stores/local-settings.svelte';
import type { ChatItemLayout } from '$lib/layout/chat-item-layout.js';
import type { PinnedInsertPosition } from '$shared/settings';
import { defaultSidebarGroupingFields, type SidebarGroupingSelection } from './sidebar-preferences';

export interface SidebarDisplayOptions {
	groupingFields: readonly SidebarGroupingSelection[];
	nestDelegatedChats: boolean;
	separateArchivedBranches: boolean;
	inactivityDuration: SidebarInactivityDuration;
	groupNestedProjectPaths: boolean;
	chatItemLayout: ChatItemLayout;
	showProjectPath: boolean;
	chatFontScale: number;
	sortMode: SidebarSortMode;
	pinnedInsertPosition: PinnedInsertPosition;
}

export type SidebarDisplayPreferences = Pick<
	LocalSettingsSnapshot,
	| 'sidebarGroupingFields'
	| 'sidebarNestDelegatedChats'
	| 'sidebarSeparateArchivedBranches'
	| 'sidebarInactivityDuration'
	| 'sidebarGroupNestedProjectPaths'
	| 'sidebarChatItemLayout'
	| 'sidebarShowProjectPath'
>;

export function defaultSidebarDisplayPreferences(): SidebarDisplayPreferences {
	return {
		sidebarGroupingFields: defaultSidebarGroupingFields(),
		sidebarNestDelegatedChats: true,
		sidebarSeparateArchivedBranches: false,
		sidebarInactivityDuration: '3-days',
		sidebarGroupNestedProjectPaths: false,
		sidebarChatItemLayout: 'single-line',
		sidebarShowProjectPath: false,
	};
}

export function sidebarDisplayOptions(
	preferences: SidebarDisplayPreferences,
	ambient: Pick<SidebarDisplayOptions, 'sortMode' | 'pinnedInsertPosition' | 'chatFontScale'>,
): SidebarDisplayOptions {
	return {
		groupingFields: preferences.sidebarGroupingFields,
		nestDelegatedChats: preferences.sidebarNestDelegatedChats,
		separateArchivedBranches: preferences.sidebarSeparateArchivedBranches,
		inactivityDuration: preferences.sidebarInactivityDuration,
		groupNestedProjectPaths: preferences.sidebarGroupNestedProjectPaths,
		chatItemLayout: preferences.sidebarChatItemLayout,
		showProjectPath: preferences.sidebarShowProjectPath,
		...ambient,
	};
}

export const DEFAULT_SIDEBAR_DISPLAY_OPTIONS = sidebarDisplayOptions(
	defaultSidebarDisplayPreferences(),
	{ chatFontScale: 1, sortMode: 'recent', pinnedInsertPosition: 'top' },
);
