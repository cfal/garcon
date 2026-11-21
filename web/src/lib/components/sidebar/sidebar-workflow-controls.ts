import type { SidebarWorkflowPageKind } from '$lib/sidebar/display/sidebar-virtual-chat-list';

export interface SidebarWorkflowControls {
	readonly selectedRunId: string | null;
	readonly fetching: boolean;
	readonly failed: boolean;
	openRun(runId: string): void;
	toggleRun(runId: string): void;
	loadMore(page: SidebarWorkflowPageKind): void;
	retry(): void;
}
