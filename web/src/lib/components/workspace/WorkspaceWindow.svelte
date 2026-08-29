<script lang="ts">
	import type { Snippet } from 'svelte';
	import ChatWindowPreview from '$lib/components/chat/ChatWindowPreview.svelte';
	import SubagentManagementControl from '$lib/components/chat/SubagentManagementControl.svelte';
	import type { ChatWindowPreviewStore } from '$lib/chat/transcript/chat-window-preview-store.svelte.js';
	import { getNotifications, getWorkspaceCoordinator, getWorkspaceWindowDnd } from '$lib/context';
	import type { WorkspaceWindowNode } from '$lib/workspace/surface-types.js';
	import {
		WORKSPACE_WINDOW_DROP_ZONES,
		type WorkspaceWindowDropZonePresentation,
	} from '$lib/workspace/window-drop-geometry.js';
	import type { RenderedPortablePresentation } from '$lib/workspace/visible-presentations.js';
	import type { SubagentToolbarState } from '$lib/chat/transcript/subagent-toolbar-state.svelte.js';
	import type { SurfaceFrameBridge } from '$lib/workspace/surface-frame-context.js';
	import type { ChatDraftAppend } from '$lib/chat/composer/chat-draft-append.js';
	import PortableSurfaceFrame from './PortableSurfaceFrame.svelte';
	import WorkspaceWindowTitleBar from './WorkspaceWindowTitleBar.svelte';
	import { cn } from '$lib/utils/cn';
	import * as m from '$lib/paraglide/messages.js';

	let {
		workspaceWindow,
		isCurrent,
		isVisible,
		chatContentMode,
		presentations,
		style,
		labelFor,
		previewStore,
		previewTextScale,
		subagentToolbar,
		chatMenuItems,
		frameBridge,
		surfaceStyle,
		onSendToChat,
		onAppendToChatDraft,
	}: {
		workspaceWindow: WorkspaceWindowNode;
		isCurrent: boolean;
		isVisible: boolean;
		chatContentMode: 'live' | 'preview' | 'none';
		presentations: readonly RenderedPortablePresentation[];
		style: string;
		labelFor: (surfaceId: string) => string;
		previewStore: ChatWindowPreviewStore;
		previewTextScale: number;
		subagentToolbar: SubagentToolbarState;
		chatMenuItems?: Snippet<[string]>;
		frameBridge(surfaceId: string): SurfaceFrameBridge;
		surfaceStyle(presentation: string): string;
		onSendToChat(message: string): Promise<boolean>;
		onAppendToChatDraft: ChatDraftAppend;
	} = $props();

	const workspace = getWorkspaceCoordinator();
	const notifications = getNotifications();
	const dnd = getWorkspaceWindowDnd();
	const snapshot = $derived(workspace.layout.snapshot);
	const activeChatIsLive = $derived(chatContentMode === 'live');
	const activeSurface = $derived(snapshot.surfaces[workspaceWindow.tabs.activeId] ?? null);
	const windowPresentations = $derived(
		presentations.filter((item) => item.windowId === workspaceWindow.id),
	);
	const activeDropTarget = $derived.by(() => {
		const target = dnd.activeTarget;
		return target?.kind === 'window' && target.windowId === workspaceWindow.id ? target : null;
	});
	const visibleDropZones = $derived(
		dnd.payload?.kind === 'chat'
			? WORKSPACE_WINDOW_DROP_ZONES.filter((entry) => entry.zone !== 'center')
			: WORKSPACE_WINDOW_DROP_ZONES,
	);
	const activeResultInset = $derived(
		activeDropTarget
			? (WORKSPACE_WINDOW_DROP_ZONES.find((entry) => entry.zone === activeDropTarget.zone)
					?.resultInsetClass ?? null)
			: null,
	);
	const dropLayerInsetClass = $derived.by(() => {
		if (dnd.payload?.kind === 'chat') return 'inset-0';
		if (workspaceWindow.tabs.order.length > 1) return 'inset-x-0 bottom-0 top-10';
		return 'inset-x-0 bottom-0 top-8';
	});

	function dropZoneLabel(zone: WorkspaceWindowDropZonePresentation): string {
		switch (zone.zone) {
			case 'top':
				return m.workspace_open_new_window_above();
			case 'bottom':
				return m.workspace_open_new_window_below();
			case 'left':
				return m.workspace_open_new_window_left();
			case 'right':
				return m.workspace_open_new_window_right();
			case 'center':
				return m.workspace_drop_zone_add_tab();
		}
	}

	function resultLabel(): string {
		if (!activeDropTarget) return '';
		if (activeDropTarget.blockedReason === 'max-windows') {
			return m.workspace_drop_zone_max_windows();
		}
		if (activeDropTarget.blockedReason === 'same-window') {
			return m.workspace_drop_zone_same_window();
		}
		const zone = WORKSPACE_WINDOW_DROP_ZONES.find((entry) => entry.zone === activeDropTarget.zone);
		return zone ? dropZoneLabel(zone) : '';
	}

	function notifyFailure(error: unknown): void {
		notifications.error(error instanceof Error ? error.message : m.workspace_open_failed());
	}

	async function handleDrop(event: DragEvent): Promise<void> {
		const commit = dnd.handleWindowDrop(workspaceWindow.id, event);
		if (!commit || commit.target.kind !== 'window') return;
		try {
			if (commit.payload.kind === 'chat') {
				if (commit.target.zone === 'center') return;
				await workspace.openChatInNewWindow(
					commit.payload.chatId,
					workspaceWindow.id,
					commit.target.zone,
				);
			} else if (commit.target.zone === 'center') {
				await workspace.moveTabToWindow(commit.payload.surfaceId, workspaceWindow.id);
			} else {
				await workspace.openTabInNewWindow(
					commit.payload.surfaceId,
					workspaceWindow.id,
					commit.target.zone,
				);
			}
		} catch (error) {
			notifyFailure(error);
		}
	}

	function focusChat(): void {
		if (activeSurface?.type === 'chat') void workspace.focusSurface(activeSurface.id);
	}
</script>

<section
	data-workspace-window-id={workspaceWindow.id}
	data-workspace-window-current={isCurrent ? 'true' : undefined}
	data-workspace-window-active-surface={workspaceWindow.tabs.activeId}
	class={cn(
		'absolute z-0 flex min-h-0 min-w-0 flex-col overflow-hidden bg-background',
		isCurrent && 'z-10',
		dnd.isDragging && 'z-50',
		!isVisible && 'hidden',
	)}
	{style}
	inert={!isVisible}
	aria-hidden={!isVisible}
	aria-label={m.workspace_window_region({ title: labelFor(workspaceWindow.tabs.activeId) })}
	onfocusin={() => workspace.noteSurfaceFocus(workspaceWindow.tabs.activeId)}
	onpointerdown={() => workspace.noteSurfaceFocus(workspaceWindow.tabs.activeId)}
	ondragover={(event) => dnd.handleWindowDragOver(workspaceWindow.id, event)}
	ondragleave={(event) => dnd.handleWindowDragLeave(event)}
	ondrop={(event) => void handleDrop(event)}
>
	<WorkspaceWindowTitleBar
		{workspaceWindow}
		{labelFor}
		{dnd}
		{isCurrent}
		menuItems={activeSurface?.type === 'chat' ? chatMenuItems : undefined}
	>
		{#snippet auxiliaryActions()}
			{#if activeChatIsLive && subagentToolbar.model}
				<SubagentManagementControl
					model={subagentToolbar.model}
					onJumpToTool={(anchorId) => subagentToolbar.jumpToTool(anchorId)}
				/>
			{/if}
		{/snippet}
	</WorkspaceWindowTitleBar>
	<div class="relative min-h-0 flex-1 overflow-hidden">
		{#if activeSurface?.type === 'chat'}
			<div
				data-workspace-surface-id={activeSurface.id}
				id={`${workspaceWindow.id}-panel-${activeSurface.id}`}
				role="tabpanel"
				tabindex="-1"
				aria-labelledby={`${workspaceWindow.id}-tab-${activeSurface.id}`}
				class="absolute inset-0"
				onfocusin={() => workspace.noteSurfaceFocus(activeSurface.id)}
				onpointerdown={() => workspace.noteSurfaceFocus(activeSurface.id)}
			>
				{#if chatContentMode === 'preview' && activeSurface.chatId}
					<ChatWindowPreview
						chatId={activeSurface.chatId}
						{previewStore}
						textScale={previewTextScale}
						onFocus={focusChat}
					/>
				{:else if chatContentMode === 'preview'}
					<div class="grid h-full place-items-center text-sm text-muted-foreground">
						{m.workspace_chat_window_empty()}
					</div>
				{/if}
			</div>
		{/if}
		{#each windowPresentations as item (`${item.presentation}:${item.surfaceId}`)}
			{@const surface = snapshot.surfaces[item.surfaceId]}
			{#if surface}
				{#key `${item.presentation}:${surface.id}`}
					<PortableSurfaceFrame
						{surface}
						presentation={item.presentation}
						visible={item.visible}
						style={surfaceStyle(item.presentation)}
						{onSendToChat}
						{onAppendToChatDraft}
						frameBridge={frameBridge(surface.id)}
					/>
				{/key}
			{/if}
		{/each}
	</div>
	{#if dnd.isDragging}
		<div
			class={cn(
				'pointer-events-auto absolute z-50',
				dropLayerInsetClass,
			)}
			data-workspace-window-drop-layer={workspaceWindow.id}
			role="status"
			aria-label={m.workspace_window_drop_target()}
		>
			{#each visibleDropZones as dropZone (dropZone.zone)}
				<div
					data-workspace-window-drop-zone={dropZone.zone}
					class={cn(
						'absolute rounded-md border border-dashed border-primary/20 bg-primary/[0.04] transition-all duration-150',
						dropZone.hitInsetClass,
						activeDropTarget?.zone === dropZone.zone &&
							'border-solid border-primary/40 bg-primary/10',
					)}
				></div>
			{/each}
			{#if activeDropTarget && activeResultInset}
				<div
					data-workspace-window-drop-result
					class={cn(
						'absolute flex items-center justify-center rounded-lg border-2 transition-all duration-150',
						activeResultInset,
						activeDropTarget.blockedReason
							? 'border-destructive/50 bg-destructive/15'
							: activeDropTarget.zone === 'center'
								? 'border-accent/50 bg-accent/20'
								: 'border-primary/50 bg-primary/20',
					)}
				>
					<span class="rounded-md bg-background/90 px-2 py-0.5 text-[10px] font-medium shadow-sm">
						{resultLabel()}
					</span>
				</div>
			{/if}
		</div>
	{/if}
</section>
