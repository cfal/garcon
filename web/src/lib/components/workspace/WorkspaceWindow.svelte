<script lang="ts">
	import { onDestroy } from 'svelte';
	import ChatEmptyState from '$lib/components/chat/ChatEmptyState.svelte';
	import ChatLoadingState from '$lib/components/chat/ChatLoadingState.svelte';
	import ConversationPanel from '$lib/components/chat/ConversationPanel.svelte';
	import { resolveChatSurfacePresentation } from '$lib/components/chat/chat-surface-presentation.js';
	import type { ConversationPanelActions } from '$lib/components/chat/conversation-panel-actions.js';
	import SubagentManagementControl from '$lib/components/chat/SubagentManagementControl.svelte';
	import {
		getChatSessions,
		getConversationPanels,
		getNotifications,
		getWorkspaceCoordinator,
		getWorkspaceWindowDnd,
	} from '$lib/context';
	import type { WorkspaceWindowNode } from '$lib/workspace/surface-types.js';
	import { resolveWorkspaceWindowCenterDropResult } from '$lib/workspace/window-dnd.svelte.js';
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
	import type { WorkspaceWindowSurfaceMenuItems } from './workspace-window-menu-contract.js';
	import { cn } from '$lib/utils/cn';
	import * as m from '$lib/paraglide/messages.js';

	let {
		workspaceWindow,
		isCurrent,
		isVisible,
		hasLeftSeparator = false,
		hasRightSeparator = false,
		presentations,
		style,
		labelFor,
		panelActions,
		composerInsetPx,
		subagentToolbar,
		surfaceMenuItems,
		frameBridge,
		surfaceStyle,
		onSendToChat,
		onAppendToChatDraft,
	}: {
		workspaceWindow: WorkspaceWindowNode;
		isCurrent: boolean;
		isVisible: boolean;
		hasLeftSeparator?: boolean;
		hasRightSeparator?: boolean;
		presentations: readonly RenderedPortablePresentation[];
		style: string;
		labelFor: (surfaceId: string) => string;
		panelActions: ConversationPanelActions | null;
		composerInsetPx: number;
		subagentToolbar: SubagentToolbarState;
		surfaceMenuItems?: WorkspaceWindowSurfaceMenuItems;
		frameBridge(surfaceId: string): SurfaceFrameBridge;
		surfaceStyle: string;
		onSendToChat(message: string): Promise<boolean>;
		onAppendToChatDraft: ChatDraftAppend;
	} = $props();

	const workspace = getWorkspaceCoordinator();
	const sessions = getChatSessions();
	const conversationPanels = getConversationPanels();
	const notifications = getNotifications();
	const dnd = getWorkspaceWindowDnd();
	const snapshot = $derived(workspace.layout.snapshot);
	const activeSurface = $derived(snapshot.surfaces[workspaceWindow.tabs.activeId] ?? null);
	const activeChatIsLive = $derived(isCurrent && activeSurface?.type === 'chat');
	const activeSurfaceIsCommandOwner = $derived(
		workspace.focusOwner.kind !== 'chat-list' &&
			workspace.focusOwner.surfaceId === activeSurface?.id,
	);
	const activeChat = $derived(
		activeSurface?.type === 'chat' && activeSurface.chatId
			? (sessions.byId[activeSurface.chatId] ?? null)
			: null,
	);
	const activePanel = $derived(
		activeSurface?.type === 'chat' ? conversationPanels.panel(activeSurface.id) : null,
	);
	const composerPanel = $derived(conversationPanels.composerPanel);
	const activeChatIsComposerAnchor = $derived(
		activeSurface?.type === 'chat' &&
			activeSurface.chatId !== null &&
			conversationPanels.isComposerTarget(activeSurface.id, activeSurface.chatId),
	);
	const activeChatOwnsComposer = $derived(activePanel !== null && activePanel === composerPanel);
	const activeChatPresentation = $derived(
		resolveChatSurfacePresentation(activeChat, sessions.isLoadingChats),
	);
	const chatSurface = $derived.by(() => {
		for (const surfaceId of workspaceWindow.tabs.order) {
			const surface = snapshot.surfaces[surfaceId];
			if (surface?.type === 'chat') return surface;
		}
		return null;
	});
	const chatIsActive = $derived(activeSurface?.id === chatSurface?.id);
	const windowPresentations = $derived(
		presentations.filter((item) => item.windowId === workspaceWindow.id),
	);
	const activeDropTarget = $derived.by(() => {
		const target = dnd.activeTarget;
		return target?.kind === 'window' && target.windowId === workspaceWindow.id ? target : null;
	});
	const activeResultInset = $derived(
		activeDropTarget
			? (WORKSPACE_WINDOW_DROP_ZONES.find((entry) => entry.zone === activeDropTarget.zone)
					?.resultInsetClass ?? null)
			: null,
	);
	const dropLayerInsetClass = $derived.by(() => {
		if (dnd.payload?.kind === 'chat') return 'inset-0';
		return 'inset-x-0 bottom-0 top-10';
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
		if (activeDropTarget.blockedReason === 'same-window') {
			return m.workspace_drop_zone_same_window();
		}
		if (activeDropTarget.blockedReason === 'too-small') {
			return m.workspace_drop_zone_too_small();
		}
		if (activeDropTarget.blockedReason === 'resource-ceiling') {
			return m.workspace_drop_zone_window_limit();
		}
		if (activeDropTarget.blockedReason === 'fullscreen') {
			return m.workspace_drop_zone_exit_fullscreen();
		}
		if (
			activeDropTarget.zone === 'center' &&
			resolveWorkspaceWindowCenterDropResult(snapshot, dnd.payload, workspaceWindow.id) ===
				'replace-chat'
		) {
			return m.workspace_drop_zone_replace_chat();
		}
		const zone = WORKSPACE_WINDOW_DROP_ZONES.find((entry) => entry.zone === activeDropTarget.zone);
		return zone ? dropZoneLabel(zone) : '';
	}

	function dropResultClass(): string {
		if (activeDropTarget?.blockedReason) return 'border-destructive/50 bg-destructive/15';
		if (activeDropTarget?.zone === 'center') return 'border-accent/50 bg-accent/20';
		return 'border-primary/50 bg-primary/20';
	}

	function notifyFailure(error: unknown): void {
		notifications.error(error instanceof Error ? error.message : m.workspace_open_failed());
	}

	async function handleDrop(event: DragEvent): Promise<void> {
		const commit = dnd.handleWindowDrop(workspaceWindow.id, event);
		if (!commit || commit.target.kind !== 'window') return;
		try {
			if (commit.payload.kind === 'chat') {
				if (commit.target.zone === 'center') {
					await workspace.showChatInWindow(commit.payload.chatId, workspaceWindow.id);
				} else {
					await workspace.openChatInNewWindow(
						commit.payload.chatId,
						workspaceWindow.id,
						commit.target.zone,
					);
				}
			} else if (commit.target.zone === 'center') {
				await workspace.moveTabToWindow(commit.payload.surfaceId, workspaceWindow.id);
			} else {
				await workspace.moveTabToNewWindow(
					commit.payload.surfaceId,
					workspaceWindow.id,
					commit.target.zone,
				);
			}
		} catch (error) {
			notifyFailure(error);
		}
	}

	let pendingPointerId: number | null = null;

	function isIsolatedTabCloseEvent(event: Event): boolean {
		return (
			event.target instanceof Element &&
			Boolean(event.target.closest('[data-workspace-window-tab-close]'))
		);
	}

	function clearPointerReleaseListeners(): void {
		document.removeEventListener('pointerup', releaseWindowPointerInteraction, true);
		document.removeEventListener('pointercancel', cancelWindowPointerInteraction, true);
		pendingPointerId = null;
	}

	function beginWindowPointerInteraction(event: PointerEvent): void {
		if (isIsolatedTabCloseEvent(event)) return;
		clearPointerReleaseListeners();
		pendingPointerId = event.pointerId;
		workspace.beginWindowPointerInteraction(workspaceWindow.id, event.pointerId);
		document.addEventListener('pointerup', releaseWindowPointerInteraction, true);
		document.addEventListener('pointercancel', cancelWindowPointerInteraction, true);
	}

	function releaseWindowPointerInteraction(event: PointerEvent): void {
		if (event.pointerId !== pendingPointerId) return;
		clearPointerReleaseListeners();
		workspace.releaseWindowPointerInteraction(workspaceWindow.id, event.pointerId);
	}

	function cancelWindowPointerInteraction(event: PointerEvent): void {
		if (event.pointerId !== pendingPointerId) return;
		clearPointerReleaseListeners();
		workspace.cancelWindowPointerInteraction(workspaceWindow.id, event.pointerId);
	}

	onDestroy(clearPointerReleaseListeners);
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
	onpointerdowncapture={beginWindowPointerInteraction}
	onclickcapture={(event) => {
		if (!isIsolatedTabCloseEvent(event)) {
			workspace.commitWindowPointerInteraction(workspaceWindow.id);
		}
	}}
	oncontextmenucapture={() => workspace.commitWindowPointerInteraction(workspaceWindow.id)}
	ondragover={(event) => dnd.handleWindowDragOver(workspaceWindow.id, event)}
	ondragleave={(event) => dnd.handleWindowDragLeave(event)}
	ondrop={(event) => void handleDrop(event)}
>
	<WorkspaceWindowTitleBar {workspaceWindow} {labelFor} {dnd} {isCurrent} {surfaceMenuItems}>
		{#snippet auxiliaryActions()}
			{#if activeChatIsLive && subagentToolbar.model}
				<SubagentManagementControl
					model={subagentToolbar.model}
					onJumpToTool={(anchorId) => subagentToolbar.jumpToTool(anchorId)}
				/>
			{/if}
		{/snippet}
	</WorkspaceWindowTitleBar>
	<div
		class={cn(
			'relative min-h-0 flex-1 overflow-hidden',
			hasLeftSeparator && 'ml-3',
			hasRightSeparator && 'mr-3',
		)}
		data-workspace-window-content={workspaceWindow.id}
	>
		{#if chatSurface}
			<div
				data-workspace-surface-id={chatSurface.id}
				id={`${workspaceWindow.id}-panel-${chatSurface.id}`}
				role="tabpanel"
				tabindex="-1"
				aria-labelledby={`${workspaceWindow.id}-tab-${chatSurface.id}`}
				inert={!chatIsActive}
				aria-hidden={!chatIsActive}
				class="absolute inset-0"
				class:invisible={!chatIsActive}
				class:pointer-events-none={!chatIsActive}
				onfocusin={() => workspace.noteSurfaceFocus(chatSurface.id)}
			>
				{#if isVisible && chatIsActive && activeChat && activePanel}
					{#key activePanel}
						<!-- Keeps the admitted chat stable while panel registration publication catches up. -->
						{const panel = activePanel}
						{const surfaceId = chatSurface.id}
						{const initialChat = activeChat}
						{const panelChat = $derived(activeChat?.id === panel.chatId ? activeChat : initialChat)}
						<ConversationPanel
							{surfaceId}
							chat={panelChat}
							{panel}
							isCommandOwner={activeSurfaceIsCommandOwner}
							ownsComposer={activeChatOwnsComposer}
							isVisible={isVisible && chatIsActive}
							actions={panelActions}
							composerInsetPx={activeChatOwnsComposer ? composerInsetPx : 0}
						/>
					{/key}
				{:else if isVisible && chatIsActive && (activeChatPresentation === 'loading' || (activeChat && !activePanel))}
					<ChatLoadingState announcementsEnabled={activeChatIsComposerAnchor} />
				{:else if isVisible && chatIsActive}
					<div class="grid h-full place-items-center text-sm text-muted-foreground">
						<ChatEmptyState />
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
						style={surfaceStyle}
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
			class={cn('pointer-events-auto absolute z-50', dropLayerInsetClass)}
			data-workspace-window-drop-layer={workspaceWindow.id}
			role="status"
			aria-label={m.workspace_window_drop_target()}
		>
			{#each WORKSPACE_WINDOW_DROP_ZONES as dropZone (dropZone.zone)}
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
						'pointer-events-none absolute flex items-center justify-center rounded-lg border-2 transition-all duration-150',
						activeResultInset,
						dropResultClass(),
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
