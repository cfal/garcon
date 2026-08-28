<script lang="ts">
	import type { Snippet } from 'svelte';
	import ChatSurface from '$lib/components/chat/ChatSurface.svelte';
	import SubagentManagementControl from '$lib/components/chat/SubagentManagementControl.svelte';
	import PortableSurfaceFrame from './PortableSurfaceFrame.svelte';
	import WorkspaceTaskBar from './WorkspaceTaskBar.svelte';
	import { getSurfaceFrames, getWorkspaceCoordinator, getWorkspacePanesContext } from '$lib/context';
	import { surfaceFrame } from '$lib/workspace/surface-frame-action';
	import { CHAT_SURFACE_ID, type PaneNode } from '$lib/workspace/surface-types.js';
	import { isSplitEdgeZone, SPLIT_DROP_ZONES } from '$lib/utils/split-drop-geometry.js';
	import type { RenderedPortablePresentation } from '$lib/workspace/visible-presentations.js';
	import { cn } from '$lib/utils/cn';
	import * as m from '$lib/paraglide/messages.js';

	let {
		pane,
		presented,
		singlePane,
		lowerToolbarForChatSplit,
		isMobile,
		presentations,
		style,
		chatLayoutMenuItems,
		chatMenuItems,
	}: {
		pane: PaneNode;
		presented: boolean;
			singlePane: boolean;
			lowerToolbarForChatSplit: boolean;
			isMobile: boolean;
		presentations: readonly RenderedPortablePresentation[];
		style: string;
		chatLayoutMenuItems?: Snippet;
		chatMenuItems?: Snippet;
	} = $props();

	const workspace = getWorkspaceCoordinator();
	const surfaceFrames = getSurfaceFrames();
	const panesContext = getWorkspacePanesContext();
	const dnd = $derived(panesContext.dnd);
	const snapshot = $derived(workspace.layout.snapshot);
	const isChatPane = $derived(pane.tabs.order.includes(CHAT_SURFACE_ID));
	const chatActive = $derived(
		isMobile
			? isChatPane && snapshot.mobileActiveSurfaceId === CHAT_SURFACE_ID
			: pane.tabs.activeId === CHAT_SURFACE_ID && presented,
	);
	const panePresentations = $derived(presentations.filter((item) => item.paneId === pane.id));
	const dropZones = SPLIT_DROP_ZONES;
	const activeDropTarget = $derived(
		dnd.activeTarget?.paneId === pane.id ? dnd.activeTarget : null,
	);
	const activeResultInset = $derived(
		activeDropTarget
			? (dropZones.find((zone) => zone.zone === activeDropTarget.zone)?.resultInsetClass ?? null)
			: null,
	);

	function dropZoneLabel(zone: (typeof SPLIT_DROP_ZONES)[number]): string {
		if (zone.zone === 'center') return m.workspace_drop_zone_add_tab();
		return zone.label();
	}

	function zoneMapClass(zone: (typeof SPLIT_DROP_ZONES)[number]): string {
		return activeDropTarget?.zone === zone.zone
			? 'border border-primary/40 bg-primary/10'
			: 'border border-dashed border-primary/20 bg-primary/[0.04]';
	}

	function resultToneClass(): string {
		if (activeDropTarget?.blockedReason === 'max-panes') {
			return 'bg-destructive/15 border-2 border-destructive/50';
		}
		return activeDropTarget?.zone === 'center'
			? 'bg-accent/20 border-2 border-accent/50'
			: 'bg-primary/20 border-2 border-primary/50';
	}

	function resultLabel(): string {
		if (!activeDropTarget) return '';
		if (activeDropTarget.blockedReason === 'max-panes') return m.workspace_drop_zone_max_panes();
		const zone = dropZones.find((entry) => entry.zone === activeDropTarget.zone);
		return zone ? dropZoneLabel(zone) : '';
	}

	function handleDrop(event: DragEvent): void {
		const target = dnd.handlePaneDrop(pane.id, event);
		if (!target) return;
		const surfaceId = dnd.draggedSurfaceId;
		if (!surfaceId) return;
		if (target.zone === 'center') {
			void workspace.moveTabToPane(surfaceId, pane.id);
		} else {
			void workspace.splitTabToEdge(surfaceId, pane.id, target.zone).catch(() => {
				// The reducer rejects no-op and over-capacity drops.
			});
		}
	}
</script>

<div
	data-workspace-pane-id={pane.id}
	class="absolute flex min-h-0 min-w-0 flex-col overflow-hidden bg-background"
	class:hidden={!presented}
	inert={!presented}
	aria-hidden={!presented}
	{style}
	ondragover={isMobile ? undefined : (event) => dnd.handlePaneDragOver(pane.id, event)}
	ondragleave={isMobile ? undefined : (event) => dnd.handlePaneDragLeave(event)}
	ondrop={isMobile ? undefined : handleDrop}
>
	{#if !isMobile}
			<div
				data-floating-workspace-toolbar
				class="pointer-events-none absolute inset-x-2 z-40 min-w-0"
				class:top-2={!lowerToolbarForChatSplit}
				class:top-9={lowerToolbarForChatSplit}
			>
			<WorkspaceTaskBar
				paneId={pane.id}
				tabs={pane.tabs}
				{singlePane}
				labelFor={panesContext.labelFor}
				onSelect={(surfaceId) => void workspace.focusSurface(surfaceId)}
				onFocus={(surfaceId) => workspace.notePaneChromeFocus(pane.id, surfaceId)}
				{dnd}
				layoutMenuItems={chatActive ? chatLayoutMenuItems : undefined}
				menuItems={chatActive ? chatMenuItems : undefined}
			>
				{#snippet startActions()}
					{#if chatActive}
						{@const toolbarModel = panesContext.subagentToolbar.model}
						{#if toolbarModel}
							<SubagentManagementControl
								model={toolbarModel}
								onJumpToTool={(anchorId) => panesContext.subagentToolbar.jumpToTool(anchorId)}
							/>
						{/if}
					{/if}
				{/snippet}
			</WorkspaceTaskBar>
		</div>
	{/if}
	<div class="relative min-h-0 flex-1 overflow-hidden">
		{#if isChatPane}
			<div
				data-workspace-surface-id={CHAT_SURFACE_ID}
				id={isMobile ? `mobile-panel-${CHAT_SURFACE_ID}` : `${pane.id}-panel-${CHAT_SURFACE_ID}`}
				role="tabpanel"
				aria-labelledby={!isMobile && pane.tabs.order.length > 1
					? `${pane.id}-tab-${CHAT_SURFACE_ID}`
					: undefined}
				aria-label={isMobile || pane.tabs.order.length === 1
					? m.workspace_surface_chat()
					: undefined}
				onfocusin={() => workspace.noteSurfaceFocus(CHAT_SURFACE_ID)}
				onpointerdown={() => workspace.noteSurfaceFocus(CHAT_SURFACE_ID)}
				class="absolute inset-0"
				class:hidden={!chatActive}
				inert={!chatActive}
				aria-hidden={!chatActive}
				use:surfaceFrame={{
					registry: surfaceFrames,
					surfaceId: CHAT_SURFACE_ID,
					host: isMobile ? 'mobile' : pane.id,
					version: 0,
				}}
			>
				<ChatSurface
					{isMobile}
					subagentToolbar={panesContext.subagentToolbar}
					reserveTopFloatingToolbar={!isMobile}
					isVisible={workspace.isChatPresented}
					isInteractive={workspace.isChatInteractive}
					onMenuClick={isMobile ? panesContext.onMobileMenuClick : undefined}
					onRegisterReload={panesContext.onRegisterReload}
					onRegisterSubmit={panesContext.onRegisterSubmit}
					onRegisterUserMessageNavigator={panesContext.onRegisterUserMessageNavigator}
					onRegisterAppendToDraft={panesContext.onRegisterAppendToDraft}
					chatActions={panesContext.chatActions}
				/>
			</div>
		{/if}
		{#each panePresentations as item (`${item.presentation}:${item.surfaceId}`)}
			{@const surface = snapshot.surfaces[item.surfaceId]}
			{#if surface}
				{#key `${item.presentation}:${surface.id}`}
					<PortableSurfaceFrame
						{surface}
						presentation={item.presentation}
						visible={item.visible && presented}
						style={panesContext.surfaceStyle(item.presentation)}
						onSendToChat={panesContext.onSendToChat}
						onAppendToChatDraft={panesContext.onAppendToChatDraft}
						frameBridge={panesContext.frameBridge(surface.id)}
					/>
				{/key}
			{/if}
		{/each}
	</div>
	{#if dnd.draggedSurfaceId && presented}
		<!-- svelte-ignore a11y_no_static_element_interactions -- transient target exists only during native drag-and-drop; follow-up: CLEANUP_ROUND_TWO.md#a11y-suppression-register -->
		<div
			class="pointer-events-none absolute inset-0 z-30"
			data-pane-drop-layer={pane.id}
			role="region"
			aria-label={m.workspace_split_drop_target()}
		>
			{#each dropZones as dropZone (dropZone.zone)}
				<div
					data-pane-drop-zone={dropZone.zone}
					class={cn(
						'absolute rounded-md transition-all duration-150',
						dropZone.hitInsetClass,
						zoneMapClass(dropZone),
					)}
				></div>
			{/each}
			{#if activeDropTarget && activeResultInset}
				<div
					data-pane-drop-result
					class={cn(
						'absolute flex items-center justify-center rounded-lg transition-all duration-150',
						activeResultInset,
						resultToneClass(),
					)}
				>
					<span
						class={cn(
							'rounded-md px-2 py-0.5 text-[10px] font-medium shadow-sm',
							activeDropTarget.blockedReason === 'max-panes'
								? 'bg-destructive/15 text-destructive'
								: activeDropTarget.zone === 'center'
									? 'bg-accent/20 text-accent-foreground'
									: 'bg-primary/15 text-primary',
						)}>{resultLabel()}</span
					>
				</div>
			{/if}
		</div>
	{/if}
</div>
