export interface SidebarDisplayOptions {
	groupByProject: boolean;
	groupNestedProjectPaths: boolean;
	compactChatItems: boolean;
}

export const DEFAULT_SIDEBAR_DISPLAY_OPTIONS: SidebarDisplayOptions = {
	groupByProject: true,
	groupNestedProjectPaths: false,
	compactChatItems: false,
};
