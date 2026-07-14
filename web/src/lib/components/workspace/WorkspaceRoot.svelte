<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import PanelRightOpen from '@lucide/svelte/icons/panel-right-open';
	import PanelRightClose from '@lucide/svelte/icons/panel-right-close';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import X from '@lucide/svelte/icons/x';
	import Maximize2 from '@lucide/svelte/icons/maximize-2';
	import Minimize2 from '@lucide/svelte/icons/minimize-2';
	import ChatSurface from '$lib/components/chat/ChatSurface.svelte';
	import CurrentChatMenuItems from '$lib/components/layout/CurrentChatMenuItems.svelte';
	import NewBranchModal from '$lib/components/git/NewBranchModal.svelte';
	import PortableSurfaceContent from './PortableSurfaceContent.svelte';
	import WorkspaceTaskBar from './WorkspaceTaskBar.svelte';
	import RightSidebarResizeHandle from './RightSidebarResizeHandle.svelte';
	import {
		getTerminalRegistry,
		getWorkspaceContext,
		getWorkspaceCoordinator,
		getSingletonSurfaces,
		getTransientLayers,
		getChatSessions,
		getModelCatalog,
		getSplitLayout,
		getGitQuickSummary,
		getGitBranchActions,
		getGhCapability,
		getLocalSettings,
		getFileSessions,
		getSurfaceFrames,
	} from '$lib/context';
	import { canUseForkAction } from '$lib/chat/fork-at-message-action';
	import { toggleChatSplitMode } from '$lib/chat/chat-split-actions';
	import {
		DEFAULT_RIGHT_SIDEBAR_WIDTH,
		getPushSidebarMaximum,
		resolveRightSidebarMetrics,
		RIGHT_SIDEBAR_HANDLE_WIDTH,
	} from '$lib/workspace/sidebar-sizing';
	import {
		CHAT_SURFACE_ID,
		MAX_PERSISTED_RIGHT_SIDEBAR_WIDTH,
		MIN_RIGHT_SIDEBAR_WIDTH,
		type HostId,
	} from '$lib/workspace/surface-types';
	import type { ChatSessionRecord } from '$lib/types/chat-session';
	import { gitProjectInvalidations } from '$lib/stores/git-project-invalidation.svelte';
	import { surfaceFrame } from '$lib/workspace/surface-frame-action';
	import { SurfaceFrameBridge } from '$lib/workspace/surface-frame-context.js';
	import {
		nextRetainedSingletonPresentationKeys,
		renderedPortablePresentations,
		visiblePortablePresentations,
	} from '$lib/workspace/visible-presentations.js';
	import * as m from '$lib/paraglide/messages.js';
	import { shouldWaitForFileRenderer } from '$lib/components/files/file-renderer-frame.js';
	import { DropdownMenuItem } from '$lib/components/ui/dropdown-menu';

	interface WorkspaceChatActions {
		requestDelete: (chat: ChatSessionRecord) => void;
		requestRename: (chat: ChatSessionRecord) => void;
		requestDetails: (chat: ChatSessionRecord) => void;
		requestShare: (chat: ChatSessionRecord) => void;
		requestProjectPath: (chat: ChatSessionRecord) => void;
		fork: (chat: ChatSessionRecord) => void;
		reload: (chat: ChatSessionRecord) => void;
	}

	let {
		isMobile,
		onMenuClick,
		isDesktopFullscreen = false,
		onToggleDesktopFullscreen,
		onRegisterReload,
		onOverlayModalChange,
		chatActions,
	}: {
		isMobile: boolean;
		onMenuClick?: () => void;
		isDesktopFullscreen?: boolean;
		onToggleDesktopFullscreen?: () => void;
		onRegisterReload?: (fn: (chatId: string) => Promise<void>) => void;
		onOverlayModalChange?: (open: boolean) => void;
		chatActions: WorkspaceChatActions;
	} = $props();

	const workspace = getWorkspaceCoordinator();
	const workspaceContext = getWorkspaceContext();
	const terminals = getTerminalRegistry();
	const transientLayers = getTransientLayers();
	const singletonSurfaces = getSingletonSurfaces();
	const sessions = getChatSessions();
	const modelCatalog = getModelCatalog();
	const splitLayout = getSplitLayout();
	const gitQuickSummary = getGitQuickSummary();
	const gitBranchActions = getGitBranchActions();
	const ghCapability = getGhCapability();
	const localSettings = getLocalSettings();
	const fileSessions = getFileSessions();
	const surfaceFrames = getSurfaceFrames();
	let hostRegion: HTMLDivElement;
	let sidebarElement: HTMLElement | null = $state(null);
	let openSidebarButton: HTMLButtonElement | null = $state(null);
	let workspaceWidth = $state(0);
	let resizeObserver: ResizeObserver | null = null;
	let resizePreviewWidth = $state<number | null>(null);
	let unregisterOverlayLayer: (() => void) | null = null;
	let reportedOverlayOpen = false;
	let chatSubmit: ((message: string) => Promise<boolean>) | null = null;
	let retainedSingletonPresentationKeys = $state.raw<ReadonlySet<string>>(new Set());
	const frameBridges = new Map<string, SurfaceFrameBridge>();

	function frameBridge(surfaceId: string): SurfaceFrameBridge {
		let bridge = frameBridges.get(surfaceId);
		if (!bridge) {
			bridge = new SurfaceFrameBridge();
			frameBridges.set(surfaceId, bridge);
		}
		return bridge;
	}
	const snapshot = $derived(workspace.layout.snapshot);
	$effect(() => {
		const liveSurfaceIds = new Set(Object.keys(snapshot.surfaces));
		for (const [surfaceId, bridge] of frameBridges) {
			if (liveSurfaceIds.has(surfaceId)) continue;
			bridge.deactivate();
			frameBridges.delete(surfaceId);
		}
	});
	const sidebarMetrics = $derived(
		resolveRightSidebarMetrics(
			workspaceWidth,
			RIGHT_SIDEBAR_HANDLE_WIDTH,
			resizePreviewWidth ?? snapshot.desiredSidebarWidth,
		),
	);
	const sidebarPushMaximum = $derived(
		Math.max(
			MIN_RIGHT_SIDEBAR_WIDTH,
			Math.floor(getPushSidebarMaximum(workspaceWidth, RIGHT_SIDEBAR_HANDLE_WIDTH)),
		),
	);
	const activeMain = $derived(snapshot.main.activeId ?? CHAT_SURFACE_ID);
	const activeSidebar = $derived(snapshot.sidebar.activeId);
	const mobileActive = $derived(snapshot.mobileActiveSurfaceId);
	const selectedChat = $derived(sessions.selectedChat);
	const canForkSelectedChat = $derived(
		selectedChat ? modelCatalog.supportsFork(selectedChat.agentId) : false,
	);
	const canForkSelectedChatNow = $derived(
		selectedChat
			? canUseForkAction({
					supportsFork: canForkSelectedChat,
					supportsForkWhileRunning: modelCatalog.supportsForkWhileRunning(selectedChat.agentId),
					isProcessing: selectedChat.isProcessing,
				})
			: false,
	);
	const sidebarPresented = $derived(
		!isMobile && snapshot.sidebarOpen && !snapshot.manualFullscreen,
	);
	const portablePresentations = $derived(visiblePortablePresentations(snapshot, isMobile));
	const renderedPresentations = $derived(
		renderedPortablePresentations(
			snapshot,
			isMobile,
			portablePresentations,
			retainedSingletonPresentationKeys,
		),
	);
	const renderedSidebarPresentations = $derived(
		renderedPresentations.filter((item) => item.presentation === 'sidebar'),
	);
	const renderedNonSidebarPresentations = $derived(
		renderedPresentations.filter((item) => item.presentation !== 'sidebar'),
	);

	$effect(() => {
		const current = untrack(() => retainedSingletonPresentationKeys);
		const next = nextRetainedSingletonPresentationKeys(
			snapshot,
			isMobile,
			portablePresentations,
			current,
		);
		if (next.size === current.size && [...next].every((key) => current.has(key))) {
			return;
		}
		retainedSingletonPresentationKeys = next;
	});

	$effect(() => {
		workspace.setSidebarOverlayMode(sidebarMetrics.mode === 'overlay');
	});

	$effect(() => {
		const open = sidebarPresented && sidebarMetrics.mode === 'overlay';
		if (open === reportedOverlayOpen) return;
		reportedOverlayOpen = open;
		untrack(() => onOverlayModalChange?.(open));
	});

	$effect(() => {
		if (!sidebarPresented || sidebarMetrics.mode !== 'overlay' || !sidebarElement) return;
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
			restoreFocus: () => openSidebarButton?.focus(),
		});
		queueMicrotask(() => {
			if (!element.isConnected) return;
			const focusTarget = overlayFocusableElements()[0];
			if (!isFocusInsideOverlay(document.activeElement)) focusTarget?.focus();
		});
		return () => {
			document.body.style.overflow = previousOverflow;
			document.body.style.touchAction = previousTouchAction;
			const hadOverlayFocus = isFocusInsideOverlay(document.activeElement);
			unregisterOverlayLayer?.();
			unregisterOverlayLayer = null;
			queueMicrotask(() => {
				if (!hadOverlayFocus || (sidebarPresented && sidebarMetrics.mode === 'push')) return;
				const mainTab = document.getElementById(`main-tab-${workspace.activeMainId}`);
				(mainTab ?? openSidebarButton)?.focus();
			});
		};
	});

	$effect(() => {
		const currentProject = workspaceContext.currentProject;
		singletonSurfaces.setGitContext(
			currentProject?.effectiveProjectKey ?? null,
			currentProject?.projectPath ?? null,
		);
		singletonSurfaces.setCommitContext(
			currentProject?.effectiveProjectKey ?? null,
			currentProject?.projectPath ?? null,
		);
	});

	$effect(() => {
		singletonSurfaces.setPullRequestsCapability(ghCapability.hasChecked, ghCapability.available);
	});

	$effect(() => {
		const currentProjectPath = workspaceContext.currentProject?.projectPath ?? null;
		const processing = sessions.selectedChat?.isProcessing ?? false;
		gitQuickSummary.setProject(currentProjectPath);
		gitQuickSummary.setEnabled(localSettings.showQuickCommitTray);
		gitQuickSummary.setProcessing(processing);
		gitBranchActions.setProject(
			currentProjectPath,
			gitQuickSummary.summaryFor(currentProjectPath)?.branch,
			workspaceContext.currentProject?.effectiveProjectKey ?? null,
		);
		return untrack(() => gitQuickSummary.startPolling());
	});

	let lastCommitInvalidationKey = '';
	$effect(() => {
		const currentProject = workspaceContext.currentProject;
		if (!currentProject) return;
		const version = gitProjectInvalidations.version(currentProject.effectiveProjectKey);
		const key = `${currentProject.effectiveProjectKey}:${version}`;
		if (version === 0 || key === lastCommitInvalidationKey) return;
		lastCommitInvalidationKey = key;
		untrack(() => gitQuickSummary.scheduleRefresh('invalidation', 100));
	});

	$effect(() => {
		const element = hostRegion;
		if (!element) return;
		resizeObserver = new ResizeObserver(([entry]) => {
			const nextWidth = entry?.contentRect.width ?? element.clientWidth;
			const nextMetrics = resolveRightSidebarMetrics(
				nextWidth,
				RIGHT_SIDEBAR_HANDLE_WIDTH,
				snapshot.desiredSidebarWidth,
			);
			if (sidebarPresented && sidebarMetrics.mode === 'push' && nextMetrics.mode === 'overlay') {
				transientLayers.open('main-inert', () => {
					workspaceWidth = nextWidth;
				});
				return;
			}
			workspaceWidth = nextWidth;
		});
		resizeObserver.observe(element);
		workspaceWidth = element.clientWidth;
		return () => {
			resizeObserver?.disconnect();
			resizeObserver = null;
		};
	});

	$effect(() => {
		const element = hostRegion;
		if (!element) return;
		element.addEventListener('keydown', handleWorkspaceKeydown);
		return () => element.removeEventListener('keydown', handleWorkspaceKeydown);
	});

	onDestroy(() => {
		resizeObserver?.disconnect();
		unregisterOverlayLayer?.();
		onOverlayModalChange?.(false);
		for (const bridge of frameBridges.values()) bridge.deactivate();
		frameBridges.clear();
	});

	function label(surfaceId: string): string {
		const surface = snapshot.surfaces[surfaceId];
		if (!surface) return m.workspace_surface_view();
		if (surface.type === 'terminal') {
			const session = getTerminalSequence(surface.terminalId);
			return session
				? m.workspace_surface_terminal_number({ number: session })
				: m.workspace_surface_terminal();
		}
		if (surface.type === 'file') {
			const session = fileSessions.get(surface.fileSessionId);
			return session
				? `${session.fileName}${session.dirty ? ' *' : ''}`
				: m.workspace_surface_file();
		}
		if (surface.type === 'terminal-launcher') return m.workspace_surface_terminal();
		const labels = {
			chat: m.workspace_surface_chat(),
			git: m.workspace_surface_git(),
			'pull-requests': m.workspace_surface_pull_requests_short(),
			files: m.workspace_surface_files(),
			commit: m.workspace_surface_commit(),
		};
		return labels[surface.kind];
	}

	function getTerminalSequence(terminalId: string): number | null {
		return terminals.sessions[terminalId]?.metadata.displaySequence ?? null;
	}

	async function sendToChat(message: string): Promise<boolean> {
		return chatSubmit ? chatSubmit(message) : false;
	}

	function overlayFocusableElements(): HTMLElement[] {
		if (!sidebarElement) return [];
		return Array.from(
			sidebarElement.querySelectorAll<HTMLElement>(
				'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
			),
		).filter((element) => !element.closest('[inert]') && element.offsetParent !== null);
	}

	function isFocusInsideOverlay(target: EventTarget | null): boolean {
		return target instanceof Node && Boolean(sidebarElement?.contains(target));
	}

	function handleWorkspaceKeydown(event: KeyboardEvent): void {
		if (!sidebarPresented || sidebarMetrics.mode !== 'overlay') return;
		if (event.key === 'Escape' && transientLayers.handleEscape(event)) return;
		if (event.key !== 'Tab') return;
		const focusable = overlayFocusableElements();
		if (focusable.length === 0) {
			event.preventDefault();
			return;
		}
		const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
		const nextIndex = event.shiftKey
			? currentIndex <= 0
				? focusable.length - 1
				: currentIndex - 1
			: currentIndex < 0 || currentIndex === focusable.length - 1
				? 0
				: currentIndex + 1;
		if (currentIndex >= 0 && currentIndex !== (event.shiftKey ? 0 : focusable.length - 1)) return;
		event.preventDefault();
		focusable[nextIndex]?.focus();
	}

	async function commitSidebarWidth(width: number): Promise<void> {
		resizePreviewWidth = width;
		try {
			await workspace.setSidebarWidth(width);
		} finally {
			if (resizePreviewWidth === width) resizePreviewWidth = null;
		}
	}

	function surfaceStyle(presentation: HostId | 'mobile'): string {
		if (presentation === 'mobile') return 'inset: 0;';
		if (presentation === 'sidebar') {
			return 'inset-block-start: var(--workspace-floating-taskbar-inset); inset-block-end: 0; inset-inline: 0;';
		}
		if (presentation === 'main') {
			const sidebarInset =
				sidebarPresented && sidebarMetrics.mode === 'push' ? sidebarMetrics.width : 0;
			return `inset-block-start: var(--workspace-floating-taskbar-inset); inset-block-end: 0; inset-inline-start: 0; inset-inline-end: ${sidebarInset}px;`;
		}
		return '';
	}
</script>

{#snippet mainMenuItems()}
	{#if activeMain === CHAT_SURFACE_ID && selectedChat && workspaceContext.currentProject}
		<CurrentChatMenuItems
			{selectedChat}
			showSplitViewAction
			showFullscreenAction={Boolean(onToggleDesktopFullscreen)}
			splitEnabled={splitLayout.isEnabled}
			{isDesktopFullscreen}
			canReload
			canUpdateProjectPath={workspaceContext.canUpdateProjectPath}
			canFork={canForkSelectedChat}
			canForkNow={canForkSelectedChatNow}
			onToggleSplitMode={() => toggleChatSplitMode(splitLayout, sessions, selectedChat)}
			{onToggleDesktopFullscreen}
			onRename={() => chatActions.requestRename(selectedChat)}
			onDetails={() => chatActions.requestDetails(selectedChat)}
			onReload={() => chatActions.reload(selectedChat)}
			onShare={() => chatActions.requestShare(selectedChat)}
			onProjectPath={() => chatActions.requestProjectPath(selectedChat)}
			onFork={() => chatActions.fork(selectedChat)}
			onDelete={() => chatActions.requestDelete(selectedChat)}
		/>
	{:else if onToggleDesktopFullscreen}
		<DropdownMenuItem onclick={onToggleDesktopFullscreen}>
			{#if isDesktopFullscreen}<Minimize2 />{:else}<Maximize2 />{/if}
			{isDesktopFullscreen ? m.workspace_exit_fullscreen() : m.workspace_enter_fullscreen()}
		</DropdownMenuItem>
	{/if}
{/snippet}

{#snippet portableSurface(surfaceId: string, presentation: HostId | 'mobile', visible: boolean)}
	{@const surface = snapshot.surfaces[surfaceId]}
	{@const fileSession = surface?.type === 'file' ? fileSessions.get(surface.fileSessionId) : null}
	{#if surface && surface.id !== CHAT_SURFACE_ID}
		{#key `${presentation}:${surface.id}`}
			<div
				data-workspace-surface-id={surface.id}
				onfocusin={() => workspace.noteSurfaceFocus(surface.id)}
				onpointerdown={() => workspace.noteSurfaceFocus(surface.id)}
				id={`${presentation}-panel-${surface.id}`}
				role="tabpanel"
				tabindex="-1"
				aria-labelledby={presentation === 'main' || presentation === 'sidebar'
					? `${presentation}-tab-${surface.id}`
					: undefined}
				inert={!visible ||
					(presentation === 'main' && sidebarPresented && sidebarMetrics.mode === 'overlay')}
				aria-hidden={!visible}
				class="absolute z-20 min-h-0 min-w-0 overflow-hidden bg-background"
				class:invisible={!visible}
				class:pointer-events-none={!visible}
				style={surfaceStyle(presentation)}
				use:surfaceFrame={{
					registry: surfaceFrames,
					surfaceId: surface.id,
					host: presentation,
					version: workspace.frameVersion(surface.id),
					renderer: frameBridge(surface.id),
					waitForRenderer:
						surface.type === 'terminal' ||
						(surface.type === 'file' && shouldWaitForFileRenderer(fileSession)),
				}}
			>
				{#if workspace.attachmentErrors[surface.id]}
					<div class="grid h-full place-items-center px-6 text-center">
						<div class="max-w-sm text-sm text-status-error-foreground">
							<p>{workspace.attachmentErrors[surface.id] || m.workspace_surface_attach_failed()}</p>
							<div class="mt-3 flex items-center justify-center gap-2">
								<button
									type="button"
									class="rounded-md border border-border px-3 py-1.5 text-xs text-foreground hover:bg-accent"
									onclick={() => void workspace.retryPresentation(surface.id, presentation)}
									>{m.common_retry()}</button
								>
								<button
									type="button"
									class="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs text-foreground hover:bg-accent disabled:opacity-50"
									onclick={() => void workspace.closeSurface(surface.id)}
									disabled={workspace.isSurfaceCloseBlocked(surface.id)}
								>
									<X class="h-3.5 w-3.5" />
									{m.workspace_close_view()}
								</button>
							</div>
						</div>
					</div>
				{:else if presentation === 'mobile' && (surface.type === 'file' || (surface.type === 'singleton' && surface.kind === 'commit'))}
					<div class="flex h-full min-h-0 flex-col">
						<div
							class="flex h-10 shrink-0 items-center gap-1 border-b border-border bg-background px-2"
						>
							<button
								type="button"
								class="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
								onclick={() => void workspace.mobileBack()}
								aria-label={m.workspace_back()}
								title={m.workspace_back()}
							>
								<ArrowLeft class="h-4 w-4" />
							</button>
							<button
								type="button"
								class="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
								onclick={() => void workspace.closeSurface(surface.id)}
								disabled={workspace.isSurfaceCloseBlocked(surface.id)}
								aria-label={m.workspace_close_view()}
								title={m.workspace_close_view()}
							>
								<X class="h-4 w-4" />
							</button>
						</div>
						<div class="min-h-0 flex-1 overflow-hidden">
							<PortableSurfaceContent
								{surface}
								{presentation}
								{visible}
								onSendToChat={sendToChat}
								frameBridge={frameBridge(surface.id)}
							/>
						</div>
					</div>
				{:else}
					<PortableSurfaceContent
						{surface}
						{presentation}
						{visible}
						onSendToChat={sendToChat}
						frameBridge={frameBridge(surface.id)}
					/>
				{/if}
			</div>
		{/key}
	{/if}
{/snippet}

<div
	bind:this={hostRegion}
	class="workspace-host-region relative flex h-full min-h-0 min-w-0 bg-background"
	style="--workspace-floating-taskbar-inset: 3rem;"
	role="region"
	aria-label={m.workspace_workspace_region()}
	tabindex="-1"
>
	<div
		class="relative flex min-h-0 min-w-0 flex-1 flex-col"
		inert={sidebarPresented && sidebarMetrics.mode === 'overlay'}
	>
		{#if !isMobile}
			<div
				data-floating-workspace-toolbar
				class={`pointer-events-none absolute inset-x-2 top-2 z-30 flex min-w-0 ${snapshot.main.order.length === 1 ? 'justify-end' : 'justify-center'}`}
			>
				<WorkspaceTaskBar
					host="main"
					hostState={snapshot.main}
					labelFor={label}
					onSelect={(surfaceId) => void workspace.focusSurface(surfaceId)}
					onFocus={(surfaceId) => workspace.noteHostChromeFocus('main', surfaceId)}
				>
					{#snippet menuItems()}{@render mainMenuItems()}{/snippet}
					{#snippet endActions()}
						{#if !snapshot.sidebarOpen && !snapshot.manualFullscreen && workspace.canOpenSidebar}
							<div
								class="relative flex shrink-0 rounded-lg border border-chat-tabs-rail-border bg-chat-tabs-rail p-0.5 text-foreground shadow-sm"
							>
								<button
									bind:this={openSidebarButton}
									type="button"
									class="relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
									onclick={() => void workspace.openSidebar()}
									aria-label={m.workspace_open_sidebar()}
									title={m.workspace_open_sidebar()}
								>
									<PanelRightOpen class="h-3.5 w-3.5" />
								</button>
							</div>
						{/if}
					{/snippet}
				</WorkspaceTaskBar>
			</div>
		{/if}
		<div class="relative min-h-0 flex-1 overflow-hidden">
			<div
				data-workspace-surface-id={CHAT_SURFACE_ID}
				id={`main-panel-${CHAT_SURFACE_ID}`}
				role="tabpanel"
				aria-labelledby={!isMobile && snapshot.main.order.length > 1
					? `main-tab-${CHAT_SURFACE_ID}`
					: undefined}
				aria-label={isMobile || snapshot.main.order.length === 1
					? m.workspace_surface_chat()
					: undefined}
				onfocusin={() => workspace.noteSurfaceFocus(CHAT_SURFACE_ID)}
				onpointerdown={() => workspace.noteSurfaceFocus(CHAT_SURFACE_ID)}
				class="absolute inset-0"
				class:hidden={isMobile ? mobileActive !== CHAT_SURFACE_ID : activeMain !== CHAT_SURFACE_ID}
				inert={isMobile ? mobileActive !== CHAT_SURFACE_ID : activeMain !== CHAT_SURFACE_ID}
				aria-hidden={isMobile ? mobileActive !== CHAT_SURFACE_ID : activeMain !== CHAT_SURFACE_ID}
				use:surfaceFrame={{
					registry: surfaceFrames,
					surfaceId: CHAT_SURFACE_ID,
					host: isMobile ? 'mobile' : 'main',
					version: 0,
				}}
			>
				<ChatSurface
					{isMobile}
					isVisible={workspace.isChatPresented}
					isInteractive={workspace.isChatInteractive}
					onMenuClick={isMobile ? onMenuClick : undefined}
					{isDesktopFullscreen}
					{onToggleDesktopFullscreen}
					{onRegisterReload}
					onRegisterSubmit={(submit) => (chatSubmit = submit)}
					{chatActions}
				/>
			</div>
		</div>
	</div>

	{#if sidebarPresented && sidebarMetrics.mode === 'push'}
		<div
			data-right-sidebar-resize-boundary
			class="pointer-events-none absolute inset-y-0 z-[45] w-px bg-border"
			style:inset-inline-end={`${sidebarMetrics.width}px`}
		>
			<RightSidebarResizeHandle
				value={sidebarMetrics.width}
				minimum={MIN_RIGHT_SIDEBAR_WIDTH}
				maximum={sidebarPushMaximum}
				label={m.workspace_resize_sidebar_pixels({
					width: Math.round(sidebarMetrics.width),
				})}
				onPreview={(width) => (resizePreviewWidth = width)}
				onCommit={(width) => void commitSidebarWidth(width)}
				onCancel={() => (resizePreviewWidth = null)}
				onReset={() => void commitSidebarWidth(DEFAULT_RIGHT_SIDEBAR_WIDTH)}
			/>
		</div>
	{/if}

	{#if sidebarPresented && sidebarMetrics.mode === 'overlay'}
		<button
			type="button"
			data-workspace-sidebar-backdrop
			class="absolute inset-0 z-30 bg-foreground/40"
			aria-label={m.workspace_close_sidebar()}
			onclick={() => void workspace.closeSidebar()}
		></button>
	{/if}

	{#if sidebarPresented || renderedSidebarPresentations.length > 0}
		<aside
			bind:this={sidebarElement}
			data-sidebar-overlay-scope={sidebarPresented && sidebarMetrics.mode === 'overlay'
				? ''
				: undefined}
			role={sidebarPresented && sidebarMetrics.mode === 'overlay' ? 'dialog' : undefined}
			aria-modal={sidebarPresented && sidebarMetrics.mode === 'overlay' ? 'true' : undefined}
			aria-label={sidebarPresented && sidebarMetrics.mode === 'overlay'
				? m.workspace_sidebar_dialog()
				: undefined}
			aria-hidden={!sidebarPresented}
			inert={!sidebarPresented}
			class="relative z-40 flex h-full min-h-0 shrink-0 flex-col border-l border-border bg-background"
			class:absolute={!sidebarPresented || sidebarMetrics.mode === 'overlay'}
			class:inset-y-0={!sidebarPresented || sidebarMetrics.mode === 'overlay'}
			class:invisible={!sidebarPresented}
			class:pointer-events-none={!sidebarPresented}
			style:inset-inline-end={!sidebarPresented || sidebarMetrics.mode === 'overlay'
				? '0'
				: undefined}
			style:width={`${sidebarMetrics.width}px`}
		>
			<div
				data-floating-sidebar-toolbar
				class="pointer-events-none absolute inset-x-2 top-2 z-30 flex min-w-0 justify-center"
			>
				<WorkspaceTaskBar
					host="sidebar"
					hostState={snapshot.sidebar}
					labelFor={label}
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
				{#each renderedSidebarPresentations as item (`${item.presentation}:${item.surfaceId}`)}
					{@render portableSurface(item.surfaceId, item.presentation, item.visible)}
				{/each}
			</div>
		</aside>
	{/if}

	{#each renderedNonSidebarPresentations as item (`${item.presentation}:${item.surfaceId}`)}
		{@render portableSurface(item.surfaceId, item.presentation, item.visible)}
	{/each}
</div>

{#if gitBranchActions.showNewBranchModal}
	<NewBranchModal
		currentBranch={gitBranchActions.newBranchCurrentBranch || 'HEAD'}
		newBranchName={gitBranchActions.newBranchName}
		refOptions={gitBranchActions.newBranchRefs}
		selectedBaseRef={gitBranchActions.newBranchBaseRef}
		isLoadingRefs={gitBranchActions.isLoadingNewBranchRefs}
		isCreatingBranch={gitBranchActions.isCreatingBranch}
		onNameChange={(name) => (gitBranchActions.newBranchName = name)}
		onBaseRefChange={(ref) => (gitBranchActions.newBranchBaseRef = ref)}
		onSearchRefs={(query) => void gitBranchActions.searchNewBranchRefs(query)}
		onCreateBranch={() => void gitBranchActions.createBranch()}
		onClose={() => gitBranchActions.closeNewBranchDialog()}
	/>
{/if}
