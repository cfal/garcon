<script lang="ts">
	import EllipsisVertical from '@lucide/svelte/icons/ellipsis-vertical';
	import { DropdownMenu, DropdownMenuTrigger } from '$lib/components/ui/dropdown-menu';
	import type { WorkspaceWindowId, WorkspaceWindowTabState } from '$lib/workspace/surface-types.js';
	import { dropdownMenuPrimitives } from '$lib/components/ui/menu-primitives.js';
	import WorkspaceWindowTabMenu from './WorkspaceWindowTabMenu.svelte';
	import type { WorkspaceWindowSurfaceMenuItems } from './workspace-window-menu-contract.js';
	import * as m from '$lib/paraglide/messages.js';

	let {
		windowId,
		tabs,
		hiddenSurfaceIds,
		labelFor,
		onSelect,
		surfaceMenuItems,
	}: {
		windowId: WorkspaceWindowId;
		tabs: WorkspaceWindowTabState;
		hiddenSurfaceIds: readonly string[];
		labelFor: (surfaceId: string) => string;
		onSelect: (surfaceId: string) => void;
		surfaceMenuItems?: WorkspaceWindowSurfaceMenuItems;
	} = $props();
</script>

<DropdownMenu>
	<DropdownMenuTrigger
		class="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
		aria-label={m.workspace_window_actions()}
		title={m.workspace_window_actions()}
		data-workspace-window-menu-trigger={windowId}
	>
		<EllipsisVertical class="h-3.5 w-3.5" />
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
