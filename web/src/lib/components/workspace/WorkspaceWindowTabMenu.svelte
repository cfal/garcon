<script lang="ts">
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import Maximize2 from '@lucide/svelte/icons/maximize-2';
	import PanelRight from '@lucide/svelte/icons/panel-right';
	import PanelTop from '@lucide/svelte/icons/panel-top';
	import X from '@lucide/svelte/icons/x';
	import { DropdownMenuContent } from '$lib/components/ui/dropdown-menu';
	import { ContextMenuContent } from '$lib/components/ui/context-menu';
	import type { MenuPrimitives } from '$lib/components/ui/menu-primitives.js';
	import { getChatSessions, getNotifications, getWorkspaceCoordinator } from '$lib/context';
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
	import { workspaceSplitBlockMessage } from '$lib/workspace/workspace-split-blocked-error.js';
	import WorkspaceSurfaceIcon from './WorkspaceSurfaceIcon.svelte';
	import WorkspaceWindowChatMetadata from './WorkspaceWindowChatMetadata.svelte';
	import type { WorkspaceWindowSurfaceMenuItems } from './workspace-window-menu-contract.js';
	import * as m from '$lib/paraglide/messages.js';

	let {
		menu,
		windowId,
		tabs,
		surfaceId,
		hiddenSurfaceIds,
		labelFor,
		onSelect,
		surfaceMenuItems,
	}: {
		menu: MenuPrimitives;
		windowId: WorkspaceWindowId;
		tabs: WorkspaceWindowTabState;
		surfaceId: string;
		hiddenSurfaceIds: readonly string[];
		labelFor: (surfaceId: string) => string;
		onSelect: (surfaceId: string) => void;
		surfaceMenuItems?: WorkspaceWindowSurfaceMenuItems;
	} = $props();

	const workspace = getWorkspaceCoordinator();
	const sessions = getChatSessions();
	const notifications = getNotifications();
	const tabActions = $derived(
		resolveWorkspaceWindowTabActions(
			workspace.layout.snapshot,
			windowId,
			tabs,
			surfaceId,
			(edge, movingSurfaceId) => workspace.resolveSplitAdmission(windowId, edge, movingSurfaceId),
		),
	);
	const surface = $derived(tabActions.surface);
	const chatMetadata = $derived.by(() => {
		if (surface?.type !== 'chat' || !surface.chatId) return null;
		const chat = sessions.byId[surface.chatId];
		return chat ? { chatId: surface.chatId, projectPath: chat.projectPath } : null;
	});
	const contentClass = $derived(chatMetadata ? 'w-80 max-w-[calc(100vw-1rem)]' : 'w-64');

	function surfaceKind(targetSurfaceId: string): ActiveSurfaceKind {
		const targetSurface = workspace.layout.surface(targetSurfaceId);
		if (!targetSurface) return 'file';
		return targetSurface.type === 'singleton' ? targetSurface.kind : targetSurface.type;
	}

	function notifyFailure(error: unknown): void {
		notifications.error(error instanceof Error ? error.message : m.workspace_open_failed());
	}

	function moveTab(destinationWindowId: WorkspaceWindowId, index?: number): void {
		void workspace.moveTabToWindow(surfaceId, destinationWindowId, index).catch(notifyFailure);
	}

	function moveTabLeft(): void {
		if (tabActions.canReorder && tabActions.index > 0) {
			moveTab(windowId, tabActions.index - 1);
		}
	}

	function moveTabRight(): void {
		if (
			tabActions.canReorder &&
			tabActions.index >= 0 &&
			tabActions.index < tabs.order.length - 1
		) {
			moveTab(windowId, tabActions.index + 1);
		}
	}

	function moveToNewWindow(edge: WorkspaceWindowEdge): void {
		void moveWorkspaceTabToNewWindow(workspace, surfaceId, windowId, edge).catch(notifyFailure);
	}

	function newWindowTitle(edge: WorkspaceWindowEdge): string | undefined {
		const admission = tabActions.newWindowEdges[edge];
		return admission && !admission.allowed
			? workspaceSplitBlockMessage(admission.reason)
			: undefined;
	}

	function closeTab(): void {
		void workspace.closeSurface(surfaceId).catch(notifyFailure);
	}
</script>

{#snippet menuItems()}
	<menu.Item
		data-workspace-window-tab-action="move-left"
		disabled={!tabActions.canReorder || tabActions.index <= 0}
		onSelect={moveTabLeft}
	>
		<ArrowLeft />
		{m.workspace_move_tab_left()}
	</menu.Item>
	<menu.Item
		data-workspace-window-tab-action="move-right"
		disabled={!tabActions.canReorder ||
			tabActions.index < 0 ||
			tabActions.index >= tabs.order.length - 1}
		onSelect={moveTabRight}
	>
		<ArrowRight />
		{m.workspace_move_tab_right()}
	</menu.Item>
	{#if tabActions.canMoveBetweenWindows}
		{#each tabActions.otherWindows as destination (destination.id)}
			{@const moveLabel = m.workspace_move_to_window({
				window: labelFor(destination.tabs.activeId),
			})}
			<menu.Item
				class="min-w-0"
				data-workspace-window-tab-action="move-to-window"
				title={moveLabel}
				onSelect={() => moveTab(destination.id)}
			>
				<PanelRight />
				<span class="min-w-0 flex-1 truncate">{moveLabel}</span>
			</menu.Item>
		{/each}
	{/if}
	<menu.Item
		data-workspace-window-tab-action="move-new-left"
		disabled={tabActions.newWindowEdges.left?.allowed !== true}
		title={newWindowTitle('left')}
		onSelect={() => moveToNewWindow('left')}
	>
		<PanelRight class="rotate-180" />
		{m.workspace_move_tab_to_new_window_left()}
	</menu.Item>
	<menu.Item
		data-workspace-window-tab-action="move-new-right"
		disabled={tabActions.newWindowEdges.right?.allowed !== true}
		title={newWindowTitle('right')}
		onSelect={() => moveToNewWindow('right')}
	>
		<PanelRight />
		{m.workspace_move_tab_to_new_window_right()}
	</menu.Item>
	<menu.Item
		data-workspace-window-tab-action="move-new-top"
		disabled={tabActions.newWindowEdges.top?.allowed !== true}
		title={newWindowTitle('top')}
		onSelect={() => moveToNewWindow('top')}
	>
		<PanelTop />
		{m.workspace_move_tab_to_new_window_above()}
	</menu.Item>
	<menu.Item
		data-workspace-window-tab-action="move-new-bottom"
		disabled={tabActions.newWindowEdges.bottom?.allowed !== true}
		title={newWindowTitle('bottom')}
		onSelect={() => moveToNewWindow('bottom')}
	>
		<PanelTop class="rotate-180" />
		{m.workspace_move_tab_to_new_window_below()}
	</menu.Item>
	<menu.Item
		data-workspace-window-tab-action="close-other-windows"
		disabled={workspace.isOtherWindowsCloseBlocked(windowId)}
		onSelect={() => void workspace.closeOtherWindows(windowId).catch(notifyFailure)}
	>
		<X />
		{m.workspace_close_other_windows()}
	</menu.Item>
	{#if surface}
		<menu.Item
			data-workspace-window-tab-action="close-tab"
			disabled={workspace.isSurfaceCloseBlocked(surfaceId)}
			onSelect={closeTab}
		>
			<X />
			{m.workspace_close_tab()}
		</menu.Item>
	{/if}
	<menu.Separator data-workspace-window-tab-actions-separator />
	{#if chatMetadata}
		<WorkspaceWindowChatMetadata
			{menu}
			projectPath={chatMetadata.projectPath}
			chatId={chatMetadata.chatId}
		/>
		<menu.Separator data-workspace-chat-metadata-separator />
	{/if}
	{#if hiddenSurfaceIds.length > 0}
		<menu.Label>{m.workspace_open_tabs()}</menu.Label>
		{#each hiddenSurfaceIds as hiddenSurfaceId (hiddenSurfaceId)}
			<menu.Item
				data-workspace-hidden-tab-id={hiddenSurfaceId}
				onSelect={() => onSelect(hiddenSurfaceId)}
			>
				<WorkspaceSurfaceIcon kind={surfaceKind(hiddenSurfaceId)} />
				<span class="min-w-0 truncate">{labelFor(hiddenSurfaceId)}</span>
			</menu.Item>
		{/each}
		<menu.Separator />
	{/if}
	{@render surfaceMenuItems?.(surfaceId, menu)}
	{#if surface?.type === 'file'}
		<menu.Item onSelect={() => void workspace.popOutFile(surface.id)}>
			<Maximize2 />
			{m.workspace_pop_out()}
		</menu.Item>
	{/if}
{/snippet}

{#if menu.kind === 'dropdown'}
	<DropdownMenuContent
		align="end"
		class={contentClass}
		data-workspace-window-menu={windowId}
		data-workspace-window-tab-menu="dropdown"
	>
		{@render menuItems()}
	</DropdownMenuContent>
{:else}
	<ContextMenuContent
		class={contentClass}
		data-workspace-window-tab-context-menu={surfaceId}
		data-workspace-window-tab-menu="context"
	>
		{@render menuItems()}
	</ContextMenuContent>
{/if}
