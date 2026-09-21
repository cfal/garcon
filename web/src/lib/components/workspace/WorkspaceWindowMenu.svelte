<script lang="ts">
	import EllipsisVertical from '@lucide/svelte/icons/ellipsis-vertical';
	import { DropdownMenu, DropdownMenuTrigger } from '$lib/components/ui/dropdown-menu';
	import type { WorkspaceWindowId, WorkspaceWindowTabState } from '$lib/workspace/surface-types.js';
	import { dropdownMenuPrimitives } from '$lib/components/ui/menu-primitives.js';
	import WorkspaceWindowTabMenu from './WorkspaceWindowTabMenu.svelte';
	import {
		DEFAULT_WORKSPACE_WINDOW_TITLEBAR_METRICS,
		type WorkspaceWindowTitlebarMetrics,
	} from './workspace-window-chrome.js';
	import type { WorkspaceWindowSurfaceMenuItems } from './workspace-window-menu-contract.js';
	import * as m from '$lib/paraglide/messages.js';

	let {
		windowId,
		tabs,
		hiddenSurfaceIds,
		labelFor,
		onSelect,
		titlebarMetrics = DEFAULT_WORKSPACE_WINDOW_TITLEBAR_METRICS,
		surfaceMenuItems,
	}: {
		windowId: WorkspaceWindowId;
		tabs: WorkspaceWindowTabState;
		hiddenSurfaceIds: readonly string[];
		labelFor: (surfaceId: string) => string;
		onSelect: (surfaceId: string) => void;
		titlebarMetrics?: WorkspaceWindowTitlebarMetrics;
		surfaceMenuItems?: WorkspaceWindowSurfaceMenuItems;
	} = $props();
</script>

<DropdownMenu>
	<DropdownMenuTrigger
		class="flex items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
		style={`height: ${titlebarMetrics.controlSizePx}px; width: ${titlebarMetrics.controlSizePx}px;`}
		aria-label={m.workspace_window_actions()}
		title={m.workspace_window_actions()}
		data-workspace-window-menu-trigger={windowId}
	>
		<EllipsisVertical size={titlebarMetrics.iconSizePx} />
	</DropdownMenuTrigger>
	<WorkspaceWindowTabMenu
		menu={dropdownMenuPrimitives}
		{windowId}
		{tabs}
		surfaceId={tabs.activeId}
		{hiddenSurfaceIds}
		{labelFor}
		{onSelect}
		{surfaceMenuItems}
	/>
</DropdownMenu>
