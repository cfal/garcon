import type { SidebarInactivityDuration, SidebarSortMode } from '$lib/stores/local-settings.svelte';
import type { ChatItemLayout } from '$lib/layout/chat-item-layout.js';
import type { PinnedInsertPosition } from '$shared/settings';
import { defaultSidebarGroupingFields, type SidebarGroupingSelection } from './sidebar-preferences';

export interface SidebarDisplayOptions {
	groupingFields: readonly SidebarGroupingSelection[];
	nestDelegatedChats: boolean;
	inactivityDuration: SidebarInactivityDuration;
	groupNestedProjectPaths: boolean;
	chatItemLayout: ChatItemLayout;
	showProjectPath: boolean;
	chatFontScale: number;
	sortMode: SidebarSortMode;
	pinnedInsertPosition: PinnedInsertPosition;
}

export const DEFAULT_SIDEBAR_DISPLAY_OPTIONS: SidebarDisplayOptions = {
	groupingFields: defaultSidebarGroupingFields(),
	nestDelegatedChats: false,
	inactivityDuration: '3-days',
	groupNestedProjectPaths: false,
	chatItemLayout: 'single-line',
	showProjectPath: false,
	chatFontScale: 1,
	sortMode: 'recent',
	pinnedInsertPosition: 'top',
};
