<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import PanelRightClose from '@lucide/svelte/icons/panel-right-close';
	import { getTransientLayers, getWorkspaceCoordinator } from '$lib/context';
	import * as m from '$lib/paraglide/messages.js';
	import type { SurfaceFrameBridge } from '$lib/workspace/surface-frame-context.js';
	import {
		DEFAULT_RIGHT_SIDEBAR_WIDTH,
		type SidebarMetrics,
	} from '$lib/workspace/sidebar-sizing.js';
	import {
		MIN_RIGHT_SIDEBAR_WIDTH,
		type HostId,
		type WorkspaceLayoutSnapshot,
	} from '$lib/workspace/surface-types.js';
	import type { RenderedPortablePresentation } from '$lib/workspace/visible-presentations.js';
	import PortableSurfaceFrame from './PortableSurfaceFrame.svelte';
	import RightSidebarResizeHandle from './RightSidebarResizeHandle.svelte';
	import WorkspaceTaskBar from './WorkspaceTaskBar.svelte';

	let {
		presented,
		metrics,
		pushMaximum,
		snapshot,
		presentations,
		labelFor,
		onSendToChat,
		frameBridge,
		surfaceStyle,
		getOpenSidebarButton,
		onPreviewWidth,
		onCommitWidth,
		onCancelWidth,
		onOverlayModalChange,
	}: {
		presented: boolean;
		metrics: SidebarMetrics;
		pushMaximum: number;
		snapshot: WorkspaceLayoutSnapshot;
		presentations: readonly RenderedPortablePresentation[];
		labelFor: (surfaceId: string) => string;
		onSendToChat: (message: string) => Promise<boolean>;
		frameBridge: (surfaceId: string) => SurfaceFrameBridge;
		surfaceStyle: (presentation: HostId | 'mobile') => string;
		getOpenSidebarButton: () => HTMLButtonElement | null;
		onPreviewWidth: (width: number) => void;
		onCommitWidth: (width: number) => void;
		onCancelWidth: () => void;
		onOverlayModalChange?: (open: boolean) => void;
	} = $props();

	const workspace = getWorkspaceCoordinator();
	const transientLayers = getTransientLayers();
	let sidebarElement: HTMLElement | null = $state(null);
	let backdropElement: HTMLButtonElement | null = $state(null);
	let unregisterOverlayLayer: (() => void) | null = null;
	let reportedOverlayOpen = false;
	const overlayOpen = $derived(presented && metrics.mode === 'overlay');

	$effect(() => {
		const open = overlayOpen;
		if (open === reportedOverlayOpen) return;
		reportedOverlayOpen = open;
		untrack(() => onOverlayModalChange?.(open));
	});

	$effect(() => {
		if (!overlayOpen || !sidebarElement) return;
		const element = sidebarElement;
		const previousOverflow = document.body.style.overflow;
		const previousTouchAction = document.body.style.touchAction;
		document.body.style.overflow = 'hidden';
		document.body.style.touchAction = 'none';
		unregisterOverlayLayer?.();
		unregisterOverlayLayer = transientLayers.register({
			id: 'workspace-sidebar-overlay',
			kind: 'sidebar-overlay',
			modality: 'main-inert',
			element: () => sidebarElement,
			onEscape: () => {
				void workspace.closeSidebar();
				return true;
			},
			restoreFocus: () => getOpenSidebarButton()?.focus(),
		});
		queueMicrotask(() => {
			if (!element.isConnected) return;
			const focusTarget = sidebarFocusableElements()[0];
			if (!containsFocus(document.activeElement)) focusTarget?.focus();
		});
		return () => {
			document.body.style.overflow = previousOverflow;
			document.body.style.touchAction = previousTouchAction;
			const hadOverlayFocus = containsFocus(document.activeElement);
			unregisterOverlayLayer?.();
			unregisterOverlayLayer = null;
			queueMicrotask(() => {
				if (!hadOverlayFocus || (presented && metrics.mode === 'push')) return;
				const mainTab = document.getElementById(`main-tab-${workspace.activeMainId}`);
				(mainTab ?? getOpenSidebarButton())?.focus();
			});
		};
	});

	onDestroy(() => {
		unregisterOverlayLayer?.();
		onOverlayModalChange?.(false);
	});

	function sidebarFocusableElements(): HTMLElement[] {
		if (!sidebarElement) return [];
		return Array.from(
			sidebarElement.querySelectorAll<HTMLElement>(
				'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
			),
		).filter((element) => !element.closest('[inert]') && element.offsetParent !== null);
	}

	function focusableElements(): HTMLElement[] {
		const backdrop = overlayOpen && backdropElement?.offsetParent !== null ? [backdropElement] : [];
		return [...backdrop, ...sidebarFocusableElements()];
	}

	function containsFocus(target: EventTarget | null): boolean {
		return (
			target instanceof Node &&
			(Boolean(sidebarElement?.contains(target)) || backdropElement === target)
		);
	}

	function handleKeydown(event: KeyboardEvent): void {
		if (!overlayOpen || event.key !== 'Tab') return;
		const focusable = focusableElements();
		if (focusable.length === 0) {
			event.preventDefault();
			return;
		}
		const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
		const atBoundary = event.shiftKey
			? currentIndex <= 0
			: currentIndex < 0 || currentIndex === focusable.length - 1;
		if (!atBoundary) return;
		event.preventDefault();
		focusable[event.shiftKey ? focusable.length - 1 : 0]?.focus();
	}
</script>

{#if presented && metrics.mode === 'push'}
	<div
		data-right-sidebar-resize-boundary
		class="pointer-events-none absolute inset-y-0 z-[45] w-px bg-border"
		style:inset-inline-end={`${metrics.width}px`}
	>
		<RightSidebarResizeHandle
			value={metrics.width}
			minimum={MIN_RIGHT_SIDEBAR_WIDTH}
			maximum={pushMaximum}
			label={m.workspace_resize_sidebar_pixels({ width: Math.round(metrics.width) })}
			onPreview={onPreviewWidth}
			onCommit={onCommitWidth}
			onCancel={onCancelWidth}
			onReset={() => onCommitWidth(DEFAULT_RIGHT_SIDEBAR_WIDTH)}
		/>
	</div>
{/if}

{#if overlayOpen}
	<button
		bind:this={backdropElement}
		type="button"
		data-workspace-sidebar-backdrop
		class="absolute inset-0 z-30 bg-foreground/40"
		aria-label={m.workspace_close_sidebar()}
		onkeydown={handleKeydown}
		onclick={() => void workspace.closeSidebar()}
	></button>
{/if}

{#if presented || presentations.length > 0}
	<aside
		bind:this={sidebarElement}
		onkeydown={handleKeydown}
		data-sidebar-overlay-scope={overlayOpen ? '' : undefined}
		role={overlayOpen ? 'dialog' : undefined}
		aria-modal={overlayOpen ? 'true' : undefined}
		aria-label={overlayOpen ? m.workspace_sidebar_dialog() : undefined}
		aria-hidden={!presented}
		inert={!presented}
		class="relative z-40 flex h-full min-h-0 shrink-0 flex-col border-l border-border bg-background"
		class:absolute={!presented || metrics.mode === 'overlay'}
		class:inset-y-0={!presented || metrics.mode === 'overlay'}
		class:invisible={!presented}
		class:pointer-events-none={!presented}
		style:inset-inline-end={!presented || metrics.mode === 'overlay' ? '0' : undefined}
		style:width={`${metrics.width}px`}
	>
		<div
			data-floating-sidebar-toolbar
			class="pointer-events-none absolute inset-x-2 top-2 z-40 flex min-w-0 justify-center"
		>
			<WorkspaceTaskBar
				host="sidebar"
				hostState={snapshot.sidebar}
				{labelFor}
				onSelect={(surfaceId) => void workspace.focusSurface(surfaceId)}
				onFocus={(surfaceId) => workspace.noteHostChromeFocus('sidebar', surfaceId)}
			>
				{#snippet endActions()}
					<div
						class="relative flex shrink-0 rounded-lg border border-chat-tabs-rail-border bg-chat-tabs-rail p-0.5 text-foreground shadow-sm"
					>
						<button
							type="button"
							class="relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
							onclick={() => void workspace.closeSidebar()}
							aria-label={m.workspace_close_sidebar()}
							title={m.workspace_close_sidebar()}
						>
							<PanelRightClose class="h-3.5 w-3.5" />
						</button>
					</div>
				{/snippet}
			</WorkspaceTaskBar>
		</div>
		<div class="relative min-h-0 flex-1 overflow-hidden">
			{#each presentations as item (`${item.presentation}:${item.surfaceId}`)}
				{@const surface = snapshot.surfaces[item.surfaceId]}
				{#if surface}
					{#key `${item.presentation}:${surface.id}`}
						<PortableSurfaceFrame
							{surface}
							presentation={item.presentation}
							visible={item.visible}
							style={surfaceStyle(item.presentation)}
							{onSendToChat}
							frameBridge={frameBridge(surface.id)}
						/>
					{/key}
				{/if}
			{/each}
		</div>
	</aside>
{/if}
