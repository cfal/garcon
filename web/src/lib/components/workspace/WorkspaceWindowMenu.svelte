<script lang="ts">
	import type { Snippet } from 'svelte';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import EllipsisVertical from '@lucide/svelte/icons/ellipsis-vertical';
	import FolderOpen from '@lucide/svelte/icons/folder-open';
	import Maximize2 from '@lucide/svelte/icons/maximize-2';
	import PanelRight from '@lucide/svelte/icons/panel-right';
	import PanelTop from '@lucide/svelte/icons/panel-top';
	import X from '@lucide/svelte/icons/x';
	import {
		DropdownMenu,
		DropdownMenuContent,
		DropdownMenuItem,
		DropdownMenuLabel,
		DropdownMenuSeparator,
		DropdownMenuTrigger,
	} from '$lib/components/ui/dropdown-menu';
	import { getFileSessions, getNotifications, getWorkspaceCoordinator } from '$lib/context';
	import type {
		ActiveSurfaceKind,
		WorkspaceWindowEdge,
		WorkspaceWindowId,
		WorkspaceWindowTabState,
	} from '$lib/workspace/surface-types.js';
	import {
		moveWorkspaceTabToNewWindow,
		resolveWorkspaceWindowTabActions,
	} from '$lib/workspace/workspace-window-tab-actions.js';
	import WorkspaceSurfaceIcon from './WorkspaceSurfaceIcon.svelte';
	import * as m from '$lib/paraglide/messages.js';

	let {
		windowId,
		tabs,
		hiddenSurfaceIds,
		labelFor,
		onSelect,
		menuItems,
	}: {
		windowId: WorkspaceWindowId;
		tabs: WorkspaceWindowTabState;
		hiddenSurfaceIds: readonly string[];
		labelFor: (surfaceId: string) => string;
		onSelect: (surfaceId: string) => void;
		menuItems?: Snippet<[string]>;
	} = $props();

	const workspace = getWorkspaceCoordinator();
	const fileSessions = getFileSessions();
	const notifications = getNotifications();
	const tabActions = $derived(
		resolveWorkspaceWindowTabActions(workspace.layout.snapshot, windowId, tabs, tabs.activeId),
	);
	const activeSurface = $derived(tabActions.surface);
	const canOfferCloseTab = $derived(tabActions.surface !== null);

	function surfaceKind(surfaceId: string): ActiveSurfaceKind {
		const surface = workspace.layout.surface(surfaceId);
		if (!surface) return 'file';
		return surface.type === 'singleton' ? surface.kind : surface.type;
	}

	function notifyFailure(error: unknown): void {
		notifications.error(error instanceof Error ? error.message : m.workspace_open_failed());
	}

	function moveTab(destinationWindowId: WorkspaceWindowId, index?: number): void {
		void workspace.moveTabToWindow(tabs.activeId, destinationWindowId, index).catch(notifyFailure);
	}

	function moveTabLeft(): void {
		if (tabActions.index > 0) moveTab(windowId, tabActions.index - 1);
	}

	function moveTabRight(): void {
		if (tabActions.index >= 0 && tabActions.index < tabs.order.length - 1)
			moveTab(windowId, tabActions.index + 1);
	}

	function moveToNewWindow(edge: WorkspaceWindowEdge): void {
		void moveWorkspaceTabToNewWindow(workspace, tabs.activeId, windowId, edge).catch(notifyFailure);
	}

	function closeActiveTab(): void {
		void workspace.closeSurface(tabs.activeId).catch(notifyFailure);
	}
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
	<DropdownMenuContent align="end" class="w-64" data-workspace-window-menu={windowId}>
		<DropdownMenuItem
			data-workspace-window-tab-action="move-left"
			disabled={!tabActions.canReorder || tabActions.index <= 0}
			onSelect={moveTabLeft}
		>
			<ArrowLeft />
			{m.workspace_move_tab_left()}
		</DropdownMenuItem>
		<DropdownMenuItem
			data-workspace-window-tab-action="move-right"
			disabled={!tabActions.canReorder ||
				tabActions.index < 0 ||
				tabActions.index >= tabs.order.length - 1}
			onSelect={moveTabRight}
		>
			<ArrowRight />
			{m.workspace_move_tab_right()}
		</DropdownMenuItem>
		{#if tabActions.canMoveBetweenWindows}
			{#each tabActions.otherWindows as destination (destination.id)}
				<DropdownMenuItem
					data-workspace-window-tab-action="move-to-window"
					onSelect={() => moveTab(destination.id)}
				>
					<PanelRight />
					{m.workspace_move_to_window({ window: labelFor(destination.tabs.activeId) })}
				</DropdownMenuItem>
			{/each}
		{/if}
		<DropdownMenuItem
			data-workspace-window-tab-action="move-new-left"
			disabled={!tabActions.canMoveToNewWindow}
			onSelect={() => moveToNewWindow('left')}
		>
			<PanelRight class="rotate-180" />
			{m.workspace_move_tab_to_new_window_left()}
		</DropdownMenuItem>
		<DropdownMenuItem
			data-workspace-window-tab-action="move-new-right"
			disabled={!tabActions.canMoveToNewWindow}
			onSelect={() => moveToNewWindow('right')}
		>
			<PanelRight />
			{m.workspace_move_tab_to_new_window_right()}
		</DropdownMenuItem>
		<DropdownMenuItem
			data-workspace-window-tab-action="move-new-top"
			disabled={!tabActions.canMoveToNewWindow}
			onSelect={() => moveToNewWindow('top')}
		>
			<PanelTop />
			{m.workspace_move_tab_to_new_window_above()}
		</DropdownMenuItem>
		<DropdownMenuItem
			data-workspace-window-tab-action="move-new-bottom"
			disabled={!tabActions.canMoveToNewWindow}
			onSelect={() => moveToNewWindow('bottom')}
		>
			<PanelTop class="rotate-180" />
			{m.workspace_move_tab_to_new_window_below()}
		</DropdownMenuItem>
		{#if canOfferCloseTab}
			<DropdownMenuItem
				data-workspace-window-tab-action="close-tab"
				disabled={workspace.isSurfaceCloseBlocked(tabs.activeId)}
				onSelect={closeActiveTab}
			>
				<X />
				{m.workspace_close_tab()}
			</DropdownMenuItem>
		{/if}
		<DropdownMenuSeparator data-workspace-window-tab-actions-separator />
		{#if hiddenSurfaceIds.length > 0}
			<DropdownMenuLabel>{m.workspace_open_tabs()}</DropdownMenuLabel>
			{#each hiddenSurfaceIds as surfaceId (surfaceId)}
				<DropdownMenuItem
					data-workspace-hidden-tab-id={surfaceId}
					onSelect={() => onSelect(surfaceId)}
				>
					<WorkspaceSurfaceIcon kind={surfaceKind(surfaceId)} />
					<span class="min-w-0 truncate">{labelFor(surfaceId)}</span>
				</DropdownMenuItem>
			{/each}
			<DropdownMenuSeparator />
		{/if}
		{#if menuItems}
			{@render menuItems(tabs.activeId)}
		{/if}
		{#if activeSurface?.type === 'singleton' && activeSurface.kind === 'files'}
			{#if menuItems}<DropdownMenuSeparator />{/if}
			<DropdownMenuItem onSelect={() => fileSessions.showOpenFiles()}>
				<FolderOpen />
				{m.file_session_file_sessions()}
			</DropdownMenuItem>
		{/if}
		{#if activeSurface?.type === 'file'}
			{#if menuItems}<DropdownMenuSeparator />{/if}
			<DropdownMenuItem onSelect={() => void workspace.popOutFile(activeSurface.id)}>
				<Maximize2 />
				{m.workspace_pop_out()}
			</DropdownMenuItem>
		{/if}
	</DropdownMenuContent>
</DropdownMenu>
