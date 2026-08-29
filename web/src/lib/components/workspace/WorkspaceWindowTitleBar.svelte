<script lang="ts">
	import type { Snippet } from 'svelte';
	import Maximize2 from '@lucide/svelte/icons/maximize-2';
	import Minimize2 from '@lucide/svelte/icons/minimize-2';
	import X from '@lucide/svelte/icons/x';
	import { getChatSessions, getNotifications, getWorkspaceCoordinator } from '$lib/context';
	import {
		workspaceChatViewCount,
		type WorkspaceWindowNode,
	} from '$lib/workspace/surface-types.js';
	import type { WorkspaceWindowDndController } from '$lib/workspace/window-dnd.svelte.js';
	import WorkspaceWindowAddMenu from './WorkspaceWindowAddMenu.svelte';
	import WorkspaceWindowMenu from './WorkspaceWindowMenu.svelte';
	import WorkspaceWindowTabStrip from './WorkspaceWindowTabStrip.svelte';
	import { cn } from '$lib/utils/cn';
	import * as m from '$lib/paraglide/messages.js';

	let {
		workspaceWindow,
		labelFor,
		dnd,
		isCurrent,
		auxiliaryActions,
		menuItems,
	}: {
		workspaceWindow: WorkspaceWindowNode;
		labelFor: (surfaceId: string) => string;
		dnd: WorkspaceWindowDndController;
		isCurrent: boolean;
		auxiliaryActions?: Snippet;
		menuItems?: Snippet<[string]>;
	} = $props();

	const workspace = getWorkspaceCoordinator();
	const sessions = getChatSessions();
	const notifications = getNotifications();
	let visibleSurfaceIds = $state.raw<readonly string[]>([]);
	const snapshot = $derived(workspace.layout.snapshot);
	const fullscreen = $derived(snapshot.fullscreenWindowId === workspaceWindow.id);
	const showActiveTreatment = $derived(isCurrent && !fullscreen);
	const hiddenSurfaceIds = $derived(
		workspaceWindow.tabs.order.filter((surfaceId) => !visibleSurfaceIds.includes(surfaceId)),
	);
	const closeDisabled = $derived(workspace.isWindowCloseBlocked(workspaceWindow.id));
	const ownsFinalChatView = $derived(
		workspaceChatViewCount(snapshot) === 1 &&
			workspaceWindow.tabs.order.some((surfaceId) => snapshot.surfaces[surfaceId]?.type === 'chat'),
	);
	const closeTitle = $derived.by(() => {
		if (!closeDisabled) return m.workspace_close_window();
		if (ownsFinalChatView) return m.workspace_close_window_final_chat_disabled();
		return m.workspace_close_window_unavailable();
	});

	function noteFocus(): void {
		workspace.noteWindowChromeFocus(workspaceWindow.id, workspaceWindow.tabs.activeId);
	}

	function isSurfaceChatProcessing(surfaceId: string): boolean {
		const surface = snapshot.surfaces[surfaceId];
		if (surface?.type !== 'chat' || !surface.chatId) return false;
		return sessions.isChatProcessing(surface.chatId);
	}

	function notifyFailure(error: unknown): void {
		notifications.error(error instanceof Error ? error.message : m.workspace_open_failed());
	}

	function toggleFullscreen(): void {
		const action = fullscreen
			? workspace.exitWindowFullscreen(workspaceWindow.id)
			: workspace.enterWindowFullscreen(workspaceWindow.id);
		void action.catch(notifyFailure);
	}

	function closeWindow(): void {
		void workspace.closeWindow(workspaceWindow.id).catch(notifyFailure);
	}
</script>

<header
	role="toolbar"
	tabindex="-1"
	data-workspace-window-titlebar={workspaceWindow.id}
	class={cn(
		'relative z-50 flex h-10 shrink-0 items-center gap-1 border-b border-border/60 bg-workspace-window-titlebar px-1.5 transition-colors',
		showActiveTreatment && 'bg-workspace-window-titlebar-active',
	)}
	onfocusin={noteFocus}
	onpointerdown={noteFocus}
>
	<div class="relative flex min-w-0 flex-1 items-center">
		<WorkspaceWindowTabStrip
			windowId={workspaceWindow.id}
			tabs={workspaceWindow.tabs}
			{labelFor}
			onSelect={(surfaceId) => void workspace.focusSurface(surfaceId)}
			onFocus={(surfaceId) => workspace.noteWindowChromeFocus(workspaceWindow.id, surfaceId)}
			{dnd}
			{isCurrent}
			isChatProcessing={isSurfaceChatProcessing}
			onVisibleChange={(ids) => (visibleSurfaceIds = ids)}
		/>
	</div>
	<div class="flex min-w-0 shrink-0 items-center gap-0.5">
		<div class="flex min-w-0 shrink empty:hidden">{@render auxiliaryActions?.()}</div>
		<WorkspaceWindowAddMenu windowId={workspaceWindow.id} tabs={workspaceWindow.tabs} />
		<WorkspaceWindowMenu
			windowId={workspaceWindow.id}
			tabs={workspaceWindow.tabs}
			{hiddenSurfaceIds}
			{labelFor}
			onSelect={(surfaceId) => void workspace.focusSurface(surfaceId)}
			{menuItems}
		/>
		<button
			type="button"
			class="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
			aria-label={fullscreen ? m.workspace_exit_fullscreen() : m.workspace_fullscreen()}
			title={fullscreen ? m.workspace_exit_fullscreen() : m.workspace_fullscreen()}
			data-workspace-window-fullscreen={workspaceWindow.id}
			onclick={toggleFullscreen}
		>
			{#if fullscreen}<Minimize2 class="h-3.5 w-3.5" />{:else}<Maximize2 class="h-3.5 w-3.5" />{/if}
		</button>
		{#if workspace.windowCount > 1}
			<button
				type="button"
				class="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40"
				aria-label={m.workspace_close_window()}
				title={closeTitle}
				disabled={closeDisabled}
				data-workspace-window-close={workspaceWindow.id}
				onclick={closeWindow}
			>
				<X class="h-3.5 w-3.5" />
			</button>
		{/if}
	</div>
</header>
