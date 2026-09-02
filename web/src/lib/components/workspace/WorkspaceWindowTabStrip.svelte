<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { mergeProps } from 'bits-ui';
	import { ContextMenu, ContextMenuTrigger } from '$lib/components/ui/context-menu';
	import { getChatSessions, getNotifications, getWorkspaceCoordinator } from '$lib/context';
	import type {
		ActiveSurfaceKind,
		WorkspaceWindowId,
		WorkspaceWindowTabState,
	} from '$lib/workspace/surface-types.js';
	import type { WorkspaceWindowDndController } from '$lib/workspace/window-dnd.svelte.js';
	import { cn } from '$lib/utils/cn';
	import {
		resolveWindowTabCapacity,
		resolveWindowTabPresentation,
		WINDOW_TAB_INLINE_CLOSE_RESERVED_WIDTH,
		type WindowTabLabelMode,
		type WindowTabPresentation,
	} from './workspace-window-tab-layout.js';
	import WorkspaceWindowTabMenu from './WorkspaceWindowTabMenu.svelte';
	import { contextMenuPrimitives } from '$lib/components/ui/menu-primitives.js';
	import type { WorkspaceWindowSurfaceMenuItems } from './workspace-window-menu-contract.js';
	import WorkspaceSurfaceIcon from './WorkspaceSurfaceIcon.svelte';
	import WorkspaceChatProcessingIndicator from './WorkspaceChatProcessingIndicator.svelte';
	import X from '@lucide/svelte/icons/x';
	import * as m from '$lib/paraglide/messages.js';

	let {
		windowId,
		tabs,
		hiddenSurfaceIds,
		labelFor,
		onSelect,
		onFocus,
		dnd,
		isCurrent,
		isChatProcessing = () => false,
		onVisibleChange,
		surfaceMenuItems,
	}: {
		windowId: WorkspaceWindowId;
		tabs: WorkspaceWindowTabState;
		hiddenSurfaceIds: readonly string[];
		labelFor: (surfaceId: string) => string;
		onSelect: (surfaceId: string) => void;
		onFocus?: (surfaceId: string) => void;
		dnd: WorkspaceWindowDndController;
		isCurrent: boolean;
		isChatProcessing?: (surfaceId: string) => boolean;
		onVisibleChange?: (ids: readonly string[]) => void;
		surfaceMenuItems?: WorkspaceWindowSurfaceMenuItems;
	} = $props();

	const workspace = getWorkspaceCoordinator();
	const sessions = getChatSessions();
	const notifications = getNotifications();
	let tabViewport: HTMLDivElement | null = $state(null);
	let measurementRail: HTMLDivElement | null = $state(null);
	let tabPresentation = $state.raw<WindowTabPresentation | null>(null);
	let closeFocusReturnTarget: HTMLElement | null = null;
	const displayedSurfaceIds = $derived(tabPresentation?.visibleIds ?? tabs.order);
	const labelMode = $derived(tabPresentation?.labelMode ?? 'full');

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

	function tooltipFor(surfaceId: string): string {
		const label = labelFor(surfaceId);
		const surface = workspace.layout.surface(surfaceId);
		if (surface?.type !== 'chat' || !surface.chatId) return label;
		const projectPath = sessions.byId[surface.chatId]?.projectPath;
		if (!projectPath) return label;
		return `${label}\n${projectPath}\n${surface.chatId}`;
	}

	function canDrag(surfaceId: string): boolean {
		const surface = workspace.layout.surface(surfaceId);
		if (!surface || surface.type === 'terminal-launcher') return false;
		return surface.type !== 'chat' || Boolean(surface.chatId);
	}

	function hasContextMenu(surfaceId: string): boolean {
		const surface = workspace.layout.surface(surfaceId);
		return Boolean(surface && surface.type !== 'terminal-launcher');
	}

	function supportsInlineClose(surfaceId: string): boolean {
		const surface = workspace.layout.surface(surfaceId);
		return Boolean(surface && surface.type !== 'terminal-launcher');
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
			trailingReservedWidths: new Map(
				tabs.order.flatMap((surfaceId) =>
					supportsInlineClose(surfaceId)
						? [[surfaceId, WINDOW_TAB_INLINE_CLOSE_RESERVED_WIDTH] as const]
						: [],
				),
			),
		});
	}

	function notifyFailure(error: unknown): void {
		notifications.error(error instanceof Error ? error.message : m.workspace_open_failed());
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
		} else if (event.key === 'Delete' && supportsInlineClose(surfaceId)) {
			event.preventDefault();
			if (!workspace.isSurfaceCloseBlocked(surfaceId)) {
				void closeTab(surfaceId, event.currentTarget as HTMLButtonElement);
			}
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

	function tabTreatment(isSelected: boolean, showSelectedBackground: boolean): string {
		if (!isSelected) return 'text-muted-foreground hover:bg-accent/60 hover:text-foreground';
		if (!showSelectedBackground) return 'text-foreground';
		if (isCurrent) return 'bg-workspace-window-tab-selected text-foreground';
		return 'bg-workspace-window-tab-selected-inactive text-foreground';
	}

	function tabFrameClass(mode: WindowTabLabelMode, reservesClose: boolean): string {
		return cn(
			'group/window-tab relative flex h-7 min-w-0 items-stretch',
			mode === 'full' && 'w-max shrink-0',
			mode === 'truncated' && 'flex-1',
			mode === 'truncated' && (reservesClose ? 'min-w-[5.5rem]' : 'min-w-16'),
			mode === 'icon-only' && 'w-7 shrink-0',
		);
	}

	function rememberCloseFocusReturnTarget(target: EventTarget | null): void {
		if (target instanceof HTMLElement && !target.closest('[data-workspace-window-tab-close]')) {
			closeFocusReturnTarget = target;
		}
	}

	function isInlineCloseTarget(target: EventTarget | null, surfaceId: string): boolean {
		return (
			target instanceof Element &&
			target.closest<HTMLElement>('[data-workspace-window-tab-close]')?.dataset
				.workspaceWindowTabClose === surfaceId
		);
	}

	function restoreFocusAfterClose(
		trigger: HTMLButtonElement,
		returnTarget: HTMLElement | null,
	): void {
		if (trigger.isConnected) return;
		if (document.activeElement !== trigger && document.activeElement !== document.body) return;
		if (returnTarget?.isConnected) {
			returnTarget.focus();
			return;
		}
		if (!isCurrent) return;
		const activeTab = Array.from(
			tabViewport?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [],
		).find((button) => button.getAttribute('aria-selected') === 'true');
		activeTab?.focus();
	}

	async function closeTab(surfaceId: string, trigger: HTMLButtonElement): Promise<void> {
		const returnTarget = closeFocusReturnTarget;
		try {
			await workspace.closeSurface(surfaceId);
		} catch (error) {
			notifyFailure(error);
		} finally {
			await tick();
			restoreFocusAfterClose(trigger, returnTarget);
		}
	}
</script>

{#snippet tabButton(surfaceId: string, measurement: boolean, triggerProps: Record<string, unknown>)}
	{@const dropPosition = measurement ? null : tabDropPosition(surfaceId)}
	{@const renderedLabelMode: WindowTabLabelMode = measurement ? 'full' : labelMode}
	{@const composedTriggerProps = measurement
		? triggerProps
		: mergeProps(triggerProps, {
				onpointerdown: (event: PointerEvent) => {
					if (isInlineCloseTarget(event.target, surfaceId)) {
						event.preventDefault();
						event.stopPropagation();
						rememberCloseFocusReturnTarget(document.activeElement);
						return;
					}
					onFocus?.(surfaceId);
				},
			})}
	{@const chatIsProcessing = !measurement && isChatProcessing(surfaceId)}
	{@const processingStatusId = `${windowId}-tab-${surfaceId}-processing`}
	{@const isSelected = !measurement && tabs.activeId === surfaceId}
	{@const showSelectedBackground = isSelected && tabs.order.length > 1}
	<button
		{...composedTriggerProps}
		type="button"
		role={measurement ? undefined : 'tab'}
		id={measurement ? undefined : `${windowId}-tab-${surfaceId}`}
		aria-controls={measurement ? undefined : `${windowId}-panel-${surfaceId}`}
		aria-selected={measurement ? undefined : tabs.activeId === surfaceId}
		aria-label={measurement ? undefined : labelFor(surfaceId)}
		aria-describedby={chatIsProcessing ? processingStatusId : undefined}
		aria-keyshortcuts={!measurement && supportsInlineClose(surfaceId) ? 'Delete' : undefined}
		tabindex={measurement ? -1 : tabs.activeId === surfaceId ? 0 : -1}
		data-workspace-tab-label-mode={measurement ? undefined : renderedLabelMode}
		class={cn(
			'relative flex h-7 w-full min-w-0 items-center gap-1.5 whitespace-nowrap rounded-md text-xs',
			'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
			renderedLabelMode !== 'icon-only' && (supportsInlineClose(surfaceId) ? 'pl-2 pr-8' : 'px-2'),
			renderedLabelMode === 'icon-only' && 'w-7 shrink-0 justify-center px-0',
			tabTreatment(isSelected, showSelectedBackground),
		)}
		title={tooltipFor(surfaceId)}
		draggable={!measurement && canDrag(surfaceId) ? true : undefined}
		ondragstart={!measurement ? (event) => handleTabDragStart(event, surfaceId) : undefined}
		ondragover={!measurement
			? (event) => dnd.handleTabDragOver(windowId, surfaceId, event)
			: undefined}
		ondrop={!measurement ? (event) => void commitTabDrop(surfaceId, event) : undefined}
		ondragend={!measurement ? () => dnd.endDrag() : undefined}
		onclick={measurement
			? undefined
			: (event) => {
					if (!isInlineCloseTarget(event.target, surfaceId)) {
						onSelect(surfaceId);
						return;
					}
					event.stopPropagation();
					if (!workspace.isSurfaceCloseBlocked(surfaceId)) {
						void closeTab(surfaceId, event.currentTarget);
					}
				}}
		onfocus={measurement
			? undefined
			: (event) => {
					rememberCloseFocusReturnTarget(event.relatedTarget);
					onFocus?.(surfaceId);
				}}
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
		{#if chatIsProcessing}
			<WorkspaceChatProcessingIndicator statusId={processingStatusId} />
		{:else}
			<WorkspaceSurfaceIcon kind={surfaceKind(surfaceId)} />
		{/if}
		<span
			class={cn(
				'min-w-0',
				renderedLabelMode === 'truncated' && 'truncate',
				renderedLabelMode === 'icon-only' && 'sr-only',
			)}>{labelFor(surfaceId)}</span
		>
		{#if !measurement && supportsInlineClose(surfaceId) && renderedLabelMode !== 'icon-only'}
			<span
				aria-hidden="true"
				data-workspace-window-tab-close={surfaceId}
				data-disabled={workspace.isSurfaceCloseBlocked(surfaceId) ? '' : undefined}
				class="pointer-events-none absolute right-0.5 top-1/2 z-10 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground opacity-0 transition-[color,background-color,opacity] group-focus-within/window-tab:pointer-events-auto group-focus-within/window-tab:opacity-100 [@media(hover:hover)_and_(pointer:fine)]:group-hover/window-tab:pointer-events-auto [@media(hover:hover)_and_(pointer:fine)]:group-hover/window-tab:opacity-100 hover:bg-accent hover:text-foreground data-[disabled]:cursor-not-allowed data-[disabled]:text-muted-foreground/40"
			>
				<X class="h-3.5 w-3.5" />
			</span>
		{/if}
	</button>
{/snippet}

{#snippet tab(surfaceId: string, measurement = false)}
	{@const renderedLabelMode: WindowTabLabelMode = measurement ? 'full' : labelMode}
	{@const showInlineClose = supportsInlineClose(surfaceId) && renderedLabelMode !== 'icon-only'}
	<div
		class={tabFrameClass(renderedLabelMode, showInlineClose)}
		data-window-tab-measure-id={measurement ? surfaceId : undefined}
	>
		{#if measurement || !hasContextMenu(surfaceId)}
			{@render tabButton(surfaceId, measurement, {})}
		{:else}
			<ContextMenu>
				<ContextMenuTrigger>
					{#snippet child({ props })}
						{@render tabButton(surfaceId, false, props)}
					{/snippet}
				</ContextMenuTrigger>
				<WorkspaceWindowTabMenu
					menu={contextMenuPrimitives}
					{windowId}
					{tabs}
					{surfaceId}
					{hiddenSurfaceIds}
					{labelFor}
					{onSelect}
					{surfaceMenuItems}
				/>
			</ContextMenu>
		{/if}
	</div>
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
