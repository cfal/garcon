<script lang="ts">
	import { untrack } from 'svelte';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import Maximize2 from '@lucide/svelte/icons/maximize-2';
	import PanelRight from '@lucide/svelte/icons/panel-right';
	import PanelTop from '@lucide/svelte/icons/panel-top';
	import X from '@lucide/svelte/icons/x';
	import {
		ContextMenu,
		ContextMenuContent,
		ContextMenuItem,
		ContextMenuTrigger,
	} from '$lib/components/ui/context-menu';
	import { getNotifications, getWorkspaceCoordinator } from '$lib/context';
	import type {
		ActiveSurfaceKind,
		WorkspaceWindowEdge,
		WorkspaceWindowId,
		WorkspaceWindowTabState,
	} from '$lib/workspace/surface-types.js';
	import { collectWindowNodes } from '$lib/workspace/window-tree.js';
	import type { WorkspaceWindowDndController } from '$lib/workspace/window-dnd.svelte.js';
	import { cn } from '$lib/utils/cn';
	import {
		resolveWindowTabCapacity,
		resolveWindowTabPresentation,
		type WindowTabLabelMode,
		type WindowTabPresentation,
	} from './workspace-window-tab-layout.js';
	import WorkspaceSurfaceIcon from './WorkspaceSurfaceIcon.svelte';
	import * as m from '$lib/paraglide/messages.js';

	let {
		windowId,
		tabs,
		labelFor,
		onSelect,
		onFocus,
		dnd,
		onVisibleChange,
	}: {
		windowId: WorkspaceWindowId;
		tabs: WorkspaceWindowTabState;
		labelFor: (surfaceId: string) => string;
		onSelect: (surfaceId: string) => void;
		onFocus?: (surfaceId: string) => void;
		dnd: WorkspaceWindowDndController;
		onVisibleChange?: (ids: readonly string[]) => void;
	} = $props();

	const workspace = getWorkspaceCoordinator();
	const notifications = getNotifications();
	let tabViewport: HTMLDivElement | null = $state(null);
	let measurementRail: HTMLDivElement | null = $state(null);
	let tabPresentation = $state.raw<WindowTabPresentation | null>(null);
	const displayedSurfaceIds = $derived(tabPresentation?.visibleIds ?? tabs.order);
	const labelMode = $derived(tabPresentation?.labelMode ?? 'full');
	const otherWindows = $derived(
		collectWindowNodes(workspace.layout.snapshot.desktopRoot).filter(
			(workspaceWindow) => workspaceWindow.id !== windowId,
		),
	);

	$effect(() => {
		tabs.order.map((surfaceId) => `${surfaceId}:${labelFor(surfaceId)}`).join('|');
		const viewport = tabViewport;
		const rail = measurementRail;
		if (!viewport || !rail || typeof ResizeObserver === 'undefined') return;
		const observer = new ResizeObserver(recomputeVisibleTabs);
		observer.observe(viewport);
		observer.observe(rail);
		for (const item of rail.querySelectorAll<HTMLElement>('[data-window-tab-measure-id]')) {
			observer.observe(item);
		}
		queueMicrotask(recomputeVisibleTabs);
		return () => observer.disconnect();
	});

	$effect(() => {
		tabs.activeId;
		if (typeof ResizeObserver === 'undefined') return;
		untrack(() => queueMicrotask(recomputeVisibleTabs));
	});

	$effect(() => {
		onVisibleChange?.(displayedSurfaceIds);
	});

	function surfaceKind(surfaceId: string): ActiveSurfaceKind {
		const surface = workspace.layout.surface(surfaceId);
		if (!surface) return 'file';
		return surface.type === 'singleton' ? surface.kind : surface.type;
	}

	function canDrag(surfaceId: string): boolean {
		const surface = workspace.layout.surface(surfaceId);
		return Boolean(surface && surface.type !== 'chat' && surface.type !== 'terminal-launcher');
	}

	function hasContextMenu(surfaceId: string): boolean {
		const surface = workspace.layout.surface(surfaceId);
		return Boolean(surface && surface.type !== 'terminal-launcher');
	}

	function canMoveBetweenWindows(surfaceId: string): boolean {
		return canDrag(surfaceId);
	}

	function canOpenInNewWindow(surfaceId: string): boolean {
		const surface = workspace.layout.surface(surfaceId);
		return Boolean(surface && (surface.type !== 'chat' || surface.chatId));
	}

	function recomputeVisibleTabs(): void {
		if (!tabViewport || !measurementRail) return;
		const widths = new Map<string, number>();
		for (const item of measurementRail.querySelectorAll<HTMLElement>(
			'[data-window-tab-measure-id]',
		)) {
			const surfaceId = item.dataset.windowTabMeasureId;
			if (surfaceId) widths.set(surfaceId, item.getBoundingClientRect().width);
		}
		const capacity = resolveWindowTabCapacity({
			containerWidth: tabViewport.clientWidth,
			actionsWidth: 0,
			auxiliaryWidth: 0,
			gap: 0,
			railChromeWidth: 0,
		});
		tabPresentation = resolveWindowTabPresentation({
			order: tabs.order,
			activeId: tabs.activeId,
			pinnedIds: [],
			availableWidth: capacity.contentWidth,
			widths,
			gap: 2,
		});
	}

	function notifyFailure(error: unknown): void {
		notifications.error(error instanceof Error ? error.message : m.workspace_open_failed());
	}

	function moveTab(
		surfaceId: string,
		destinationWindowId: WorkspaceWindowId,
		index?: number,
	): void {
		void workspace.moveTabToWindow(surfaceId, destinationWindowId, index).catch(notifyFailure);
	}

	function moveTabLeft(surfaceId: string): void {
		const index = tabs.order.indexOf(surfaceId);
		if (index > 0) moveTab(surfaceId, windowId, index - 1);
	}

	function moveTabRight(surfaceId: string): void {
		const index = tabs.order.indexOf(surfaceId);
		if (index >= 0 && index < tabs.order.length - 1) moveTab(surfaceId, windowId, index + 1);
	}

	function openInNewWindow(surfaceId: string, edge: WorkspaceWindowEdge): void {
		const surface = workspace.layout.surface(surfaceId);
		const action =
			surface?.type === 'chat'
				? surface.chatId
					? workspace.openChatInNewWindow(surface.chatId, windowId, edge)
					: Promise.resolve()
				: workspace.openTabInNewWindow(surfaceId, windowId, edge);
		void action.catch(notifyFailure);
	}

	function handleKeydown(event: KeyboardEvent, surfaceId: string): void {
		const buttons = Array.from(
			tabViewport?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [],
		);
		const index = buttons.indexOf(event.currentTarget as HTMLButtonElement);
		if (index < 0 || buttons.length === 0) return;
		let nextIndex: number;
		if (event.key === 'ArrowLeft') nextIndex = (index - 1 + buttons.length) % buttons.length;
		else if (event.key === 'ArrowRight') nextIndex = (index + 1) % buttons.length;
		else if (event.key === 'Home') nextIndex = 0;
		else if (event.key === 'End') nextIndex = buttons.length - 1;
		else if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			onSelect(surfaceId);
			return;
		} else return;
		event.preventDefault();
		buttons[nextIndex]?.focus();
	}

	function handleTabDragStart(event: DragEvent, surfaceId: string): void {
		const sourceIndex = tabs.order.indexOf(surfaceId);
		if (sourceIndex >= 0) dnd.beginSurfaceTabDrag(surfaceId, windowId, sourceIndex, event);
	}

	async function commitTabDrop(referenceSurfaceId: string | null, event: DragEvent): Promise<void> {
		const commit = dnd.handleTabDrop(windowId, referenceSurfaceId, event);
		if (!commit || commit.payload.kind !== 'surface-tab' || commit.target.kind !== 'tab') return;
		try {
			await workspace.moveTabToWindow(
				commit.payload.surfaceId,
				commit.target.windowId,
				commit.target.index,
			);
		} catch (error) {
			notifyFailure(error);
		}
	}

	function tabDropPosition(surfaceId: string): 'before' | 'after' | null {
		const target = dnd.activeTarget;
		if (target?.kind !== 'tab' || target.windowId !== windowId) return null;
		return target.referenceSurfaceId === surfaceId ? target.position : null;
	}
</script>

{#snippet tabButton(surfaceId: string, measurement: boolean, triggerProps: Record<string, unknown>)}
	{@const dropPosition = measurement ? null : tabDropPosition(surfaceId)}
	{@const renderedLabelMode: WindowTabLabelMode = measurement ? 'full' : labelMode}
	<button
		{...triggerProps}
		type="button"
		role={measurement ? undefined : 'tab'}
		id={measurement ? undefined : `${windowId}-tab-${surfaceId}`}
		aria-controls={measurement ? undefined : `${windowId}-panel-${surfaceId}`}
		aria-selected={measurement ? undefined : tabs.activeId === surfaceId}
		tabindex={measurement ? -1 : tabs.activeId === surfaceId ? 0 : -1}
		data-window-tab-measure-id={measurement ? surfaceId : undefined}
		data-workspace-tab-label-mode={measurement ? undefined : renderedLabelMode}
		class={cn(
			'relative flex h-7 min-w-0 items-center gap-1.5 whitespace-nowrap rounded-md text-xs',
			'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
			renderedLabelMode === 'full' && 'w-max shrink-0 px-2',
			renderedLabelMode === 'truncated' && 'min-w-16 flex-1 px-2',
			renderedLabelMode === 'icon-only' && 'w-7 shrink-0 justify-center px-0',
			!measurement && tabs.activeId === surfaceId
				? 'bg-accent text-accent-foreground'
				: 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
		)}
		title={labelFor(surfaceId)}
		draggable={!measurement && canDrag(surfaceId) ? true : undefined}
		ondragstart={!measurement ? (event) => handleTabDragStart(event, surfaceId) : undefined}
		ondragover={!measurement
			? (event) => dnd.handleTabDragOver(windowId, surfaceId, event)
			: undefined}
		ondrop={!measurement ? (event) => void commitTabDrop(surfaceId, event) : undefined}
		ondragend={!measurement ? () => dnd.endDrag() : undefined}
		onclick={measurement ? undefined : () => onSelect(surfaceId)}
		onfocus={measurement ? undefined : () => onFocus?.(surfaceId)}
		onpointerdown={measurement ? undefined : () => onFocus?.(surfaceId)}
		onkeydown={measurement ? undefined : (event) => handleKeydown(event, surfaceId)}
	>
		{#if dropPosition}
			<span
				data-workspace-tab-drop-position={dropPosition}
				class="pointer-events-none absolute inset-y-1 w-0.5 rounded-full bg-primary"
				class:left-0={dropPosition === 'before'}
				class:right-0={dropPosition === 'after'}
			></span>
		{/if}
		<WorkspaceSurfaceIcon kind={surfaceKind(surfaceId)} />
		<span
			class={cn(
				'min-w-0',
				renderedLabelMode === 'truncated' && 'truncate',
				renderedLabelMode === 'icon-only' && 'sr-only',
			)}>{labelFor(surfaceId)}</span
		>
	</button>
{/snippet}

{#snippet tab(surfaceId: string, measurement = false)}
	{#if measurement || !hasContextMenu(surfaceId)}
		{@render tabButton(surfaceId, measurement, {})}
	{:else}
		<ContextMenu>
			<ContextMenuTrigger>
				{#snippet child({ props })}
					{@render tabButton(surfaceId, false, props)}
				{/snippet}
			</ContextMenuTrigger>
			<ContextMenuContent class="w-64">
				{@const index = tabs.order.indexOf(surfaceId)}
				<ContextMenuItem disabled={index <= 0} onclick={() => moveTabLeft(surfaceId)}>
					<ArrowLeft />
					{m.workspace_move_tab_left()}
				</ContextMenuItem>
				<ContextMenuItem
					disabled={index < 0 || index >= tabs.order.length - 1}
					onclick={() => moveTabRight(surfaceId)}
				>
					<ArrowRight />
					{m.workspace_move_tab_right()}
				</ContextMenuItem>
				{#if canMoveBetweenWindows(surfaceId)}
					{#each otherWindows as destination (destination.id)}
						<ContextMenuItem onclick={() => moveTab(surfaceId, destination.id)}>
							<PanelRight />
							{m.workspace_move_to_window({ window: labelFor(destination.tabs.activeId) })}
						</ContextMenuItem>
					{/each}
				{/if}
				<ContextMenuItem
					disabled={!canOpenInNewWindow(surfaceId)}
					onclick={() => openInNewWindow(surfaceId, 'left')}
				>
					<PanelRight class="rotate-180" />
					{m.workspace_open_tab_new_window_left()}
				</ContextMenuItem>
				<ContextMenuItem
					disabled={!canOpenInNewWindow(surfaceId)}
					onclick={() => openInNewWindow(surfaceId, 'right')}
				>
					<PanelRight />
					{m.workspace_open_tab_new_window_right()}
				</ContextMenuItem>
				<ContextMenuItem
					disabled={!canOpenInNewWindow(surfaceId)}
					onclick={() => openInNewWindow(surfaceId, 'top')}
				>
					<PanelTop />
					{m.workspace_open_tab_new_window_above()}
				</ContextMenuItem>
				<ContextMenuItem
					disabled={!canOpenInNewWindow(surfaceId)}
					onclick={() => openInNewWindow(surfaceId, 'bottom')}
				>
					<PanelTop class="rotate-180" />
					{m.workspace_open_tab_new_window_below()}
				</ContextMenuItem>
				{#if workspace.layout.surface(surfaceId)?.type === 'file'}
					<ContextMenuItem onclick={() => void workspace.popOutFile(surfaceId)}>
						<Maximize2 />
						{m.workspace_pop_out()}
					</ContextMenuItem>
				{/if}
				<ContextMenuItem
					variant="destructive"
					disabled={workspace.isSurfaceCloseBlocked(surfaceId)}
					onclick={() => void workspace.closeSurface(surfaceId)}
				>
					<X />
					{m.workspace_close_tab()}
				</ContextMenuItem>
			</ContextMenuContent>
		</ContextMenu>
	{/if}
{/snippet}

<div
	bind:this={tabViewport}
	class="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden"
	role="tablist"
	tabindex="-1"
	aria-label={m.workspace_window_views()}
	data-workspace-window-tabs={windowId}
	data-workspace-tab-label-mode={labelMode}
	ondragover={(event) => dnd.handleTabListDragOver(windowId, event)}
	ondrop={(event) => void commitTabDrop(null, event)}
>
	{#each displayedSurfaceIds as surfaceId (surfaceId)}
		{@render tab(surfaceId)}
	{/each}
</div>

<div
	bind:this={measurementRail}
	class="pointer-events-none invisible absolute -left-[10000px] top-0 flex items-center gap-0.5"
	aria-hidden="true"
>
	{#each tabs.order as surfaceId (surfaceId)}
		{@render tab(surfaceId, true)}
	{/each}
</div>
