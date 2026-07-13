<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import PanelRightOpen from '@lucide/svelte/icons/panel-right-open';
	import PanelRightClose from '@lucide/svelte/icons/panel-right-close';
	import PanelLeft from '@lucide/svelte/icons/panel-left';
	import PanelRight from '@lucide/svelte/icons/panel-right';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import X from '@lucide/svelte/icons/x';
	import Maximize2 from '@lucide/svelte/icons/maximize-2';
	import Minimize2 from '@lucide/svelte/icons/minimize-2';
	import ChatSurface from '$lib/components/chat/ChatSurface.svelte';
	import CurrentChatMenu from '$lib/components/layout/CurrentChatMenu.svelte';
	import NewBranchModal from '$lib/components/git/NewBranchModal.svelte';
	import PortableSurfaceContent from './PortableSurfaceContent.svelte';
	import SurfaceTabRail from './SurfaceTabRail.svelte';
	import AddSurfaceMenu from './AddSurfaceMenu.svelte';
	import {
		getTerminalRegistry,
		getWorkspaceContext,
		getWorkspaceCoordinator,
		getChatInteractionGate,
		getQuickGit,
		getTransientLayers,
		getChatSessions,
		getModelCatalog,
		getSplitLayout,
		getGitQuickSummary,
		getGitBranchActions,
		getLocalSettings,
		getFileSessions,
		getSurfaceFrames,
	} from '$lib/context';
	import { canUseForkAction } from '$lib/chat/fork-at-message-action';
	import { toggleChatSplitMode } from '$lib/chat/chat-split-actions';
	import { clampPushSidebarWidth, resolveRightSidebarMetrics } from '$lib/workspace/sidebar-sizing';
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
	import * as m from '$lib/paraglide/messages.js';

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
		chatActions,
	}: {
		isMobile: boolean;
		onMenuClick?: () => void;
		isDesktopFullscreen?: boolean;
		onToggleDesktopFullscreen?: () => void;
		onRegisterReload?: (fn: (chatId: string) => Promise<void>) => void;
		chatActions: WorkspaceChatActions;
	} = $props();

	const workspace = getWorkspaceCoordinator();
	const workspaceContext = getWorkspaceContext();
	const terminals = getTerminalRegistry();
	const chatInteractionGate = getChatInteractionGate();
	const transientLayers = getTransientLayers();
	const quickGit = getQuickGit();
	const sessions = getChatSessions();
	const modelCatalog = getModelCatalog();
	const splitLayout = getSplitLayout();
	const gitQuickSummary = getGitQuickSummary();
	const gitBranchActions = getGitBranchActions();
	const localSettings = getLocalSettings();
	const fileSessions = getFileSessions();
	const surfaceFrames = getSurfaceFrames();
	let hostRegion: HTMLDivElement;
	let sidebarElement: HTMLElement | null = $state(null);
	let openSidebarButton: HTMLButtonElement | null = $state(null);
	let workspaceWidth = $state(0);
	let resizeObserver: ResizeObserver | null = null;
	let resizeCleanup: (() => void) | null = null;
	let unregisterOverlayLayer: (() => void) | null = null;
	let chatSubmit: ((message: string) => Promise<boolean>) | null = null;
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
		resolveRightSidebarMetrics(workspaceWidth, 5, snapshot.desiredSidebarWidth),
	);
	const sidebarPushMaximum = $derived(
		Math.max(
			MIN_RIGHT_SIDEBAR_WIDTH,
			Math.floor(Math.min(workspaceWidth * 0.7, workspaceWidth - 480 - 5)),
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
	const portableSurfaces = $derived(
		Object.values(snapshot.surfaces).filter((surface) => surface.id !== CHAT_SURFACE_ID),
	);
	const sidebarPresented = $derived(
		!isMobile && snapshot.sidebarOpen && !snapshot.manualFullscreen,
	);

	$effect(() => {
		chatInteractionGate.setPresentation(workspace.isChatPresented, !workspace.isChatInteractive);
	});

	$effect(() => {
		workspace.setSidebarOverlayMode(sidebarMetrics.mode === 'overlay');
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
		void quickGit.setContext(
			currentProject?.effectiveProjectKey ?? null,
			currentProject?.projectPath ?? null,
		);
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

	let lastQuickGitInvalidationKey = '';
	$effect(() => {
		const currentProject = workspaceContext.currentProject;
		if (!currentProject) return;
		const version = gitProjectInvalidations.version(currentProject.effectiveProjectKey);
		const key = `${currentProject.effectiveProjectKey}:${version}`;
		if (version === 0 || key === lastQuickGitInvalidationKey) return;
		lastQuickGitInvalidationKey = key;
		untrack(() => gitQuickSummary.scheduleRefresh('invalidation', 100));
	});

	$effect(() => {
		const surfaceId = 'singleton:quick-git';
		const visible = isMobile
			? mobileActive === surfaceId
			: activeMain === surfaceId ||
				(snapshot.sidebarOpen && !snapshot.manualFullscreen && activeSidebar === surfaceId);
		void quickGit.setPresentationVisible(visible);
	});

	$effect(() => {
		const element = hostRegion;
		if (!element) return;
		resizeObserver = new ResizeObserver(([entry]) => {
			const nextWidth = entry?.contentRect.width ?? element.clientWidth;
			const nextMetrics = resolveRightSidebarMetrics(nextWidth, 5, snapshot.desiredSidebarWidth);
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
		resizeCleanup?.();
		unregisterOverlayLayer?.();
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
			'quick-git': m.workspace_surface_quick_git(),
		};
		return labels[surface.kind];
	}

	function getTerminalSequence(terminalId: string): number | null {
		return terminals.sessions[terminalId]?.metadata.displaySequence ?? null;
	}

	async function sendToChat(message: string): Promise<boolean> {
		return chatSubmit ? chatSubmit(message) : false;
	}

	function startResize(event: PointerEvent): void {
		if (sidebarMetrics.mode !== 'push') return;
		event.preventDefault();
		const startX = event.clientX;
		const startWidth = sidebarMetrics.width;
		const inlineDirection = getComputedStyle(hostRegion).direction === 'rtl' ? -1 : 1;
		const onMove = (moveEvent: PointerEvent) => {
			const width = clampPushSidebarWidth(
				startWidth + (startX - moveEvent.clientX) * inlineDirection,
				sidebarPushMaximum,
			);
			void workspace.setSidebarWidth(width);
		};
		const stop = () => {
			document.removeEventListener('pointermove', onMove);
			document.removeEventListener('pointerup', stop);
			document.body.style.cursor = '';
			resizeCleanup = null;
		};
		document.body.style.cursor = 'col-resize';
		document.addEventListener('pointermove', onMove);
		document.addEventListener('pointerup', stop);
		resizeCleanup = stop;
	}

	function overlayFocusableElements(): HTMLElement[] {
		if (!hostRegion) return [];
		return Array.from(
			hostRegion.querySelectorAll<HTMLElement>(
				'[data-sidebar-overlay-scope] button:not(:disabled), [data-sidebar-overlay-scope] a[href], [data-sidebar-overlay-scope] input:not(:disabled), [data-sidebar-overlay-scope] select:not(:disabled), [data-sidebar-overlay-scope] textarea:not(:disabled), [data-sidebar-overlay-scope] [tabindex]:not([tabindex="-1"])',
			),
		).filter((element) => !element.closest('[inert]') && element.offsetParent !== null);
	}

	function isFocusInsideOverlay(target: EventTarget | null): boolean {
		return target instanceof Element && Boolean(target.closest('[data-sidebar-overlay-scope]'));
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

	function handleResizeKey(event: KeyboardEvent): void {
		if (event.key === 'Home') {
			event.preventDefault();
			void workspace.setSidebarWidth(480);
			return;
		}
		if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
		event.preventDefault();
		const step = event.shiftKey ? 40 : 10;
		const rtl = getComputedStyle(hostRegion).direction === 'rtl';
		const direction = event.key === (rtl ? 'ArrowRight' : 'ArrowLeft') ? 1 : -1;
		const width = clampPushSidebarWidth(
			snapshot.desiredSidebarWidth + step * direction,
			sidebarPushMaximum,
		);
		void workspace.setSidebarWidth(width);
	}

	function activeFor(host: HostId): string | null {
		return host === 'main' ? activeMain : activeSidebar;
	}

	function presentationFor(surfaceId: string): HostId | 'mobile' | null {
		if (isMobile) return mobileActive === surfaceId ? 'mobile' : null;
		if (activeMain === surfaceId) return 'main';
		if (sidebarPresented && activeSidebar === surfaceId) return 'sidebar';
		return null;
	}

	function surfaceStyle(presentation: HostId | 'mobile' | null): string {
		if (presentation === 'mobile') return 'inset: 0;';
		if (presentation === 'sidebar') {
			return `inset-block-start: 48px; inset-block-end: 0; inset-inline-end: 0; width: ${sidebarMetrics.width}px;`;
		}
		if (presentation === 'main') {
			const sidebarInset =
				sidebarPresented && sidebarMetrics.mode === 'push' ? sidebarMetrics.width : 0;
			return `inset-block-start: 48px; inset-block-end: 0; inset-inline-start: 0; inset-inline-end: ${sidebarInset}px;`;
		}
		return '';
	}
</script>

{#snippet tabRail(host: HostId)}
	<SurfaceTabRail
		{host}
		hostState={snapshot[host]}
		labelFor={label}
		onSelect={(surfaceId) => void workspace.focusSurface(surfaceId)}
		onFocus={(surfaceId) => workspace.noteHostChromeFocus(host, surfaceId)}
	/>
{/snippet}

{#snippet placementControls(host: HostId)}
	{@const surfaceId = activeFor(host)}
	{#if surfaceId && surfaceId !== CHAT_SURFACE_ID}
		{#if snapshot.surfaces[surfaceId]?.type === 'file'}
			<button
				type="button"
				class="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
				onclick={() => void workspace.popOutFile(surfaceId)}
				aria-label={m.workspace_pop_out()}
				title={m.workspace_pop_out()}
			>
				<Maximize2 class="h-4 w-4" />
			</button>
		{/if}
		<button
			type="button"
			class="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
			onclick={() => void workspace.moveSurface(surfaceId, host === 'main' ? 'sidebar' : 'main')}
			aria-label={host === 'main' ? m.workspace_move_to_sidebar() : m.workspace_move_to_main()}
			title={host === 'main' ? m.workspace_move_to_sidebar() : m.workspace_move_to_main()}
		>
			{#if host === 'main'}<PanelRight class="h-4 w-4" />{:else}<PanelLeft class="h-4 w-4" />{/if}
		</button>
		<button
			type="button"
			class="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
			onclick={() => void workspace.closeSurface(surfaceId)}
			disabled={workspace.isSurfaceCloseBlocked(surfaceId)}
			aria-label={m.workspace_close_view()}
			title={m.workspace_close_view()}
		>
			<X class="h-4 w-4" />
		</button>
	{/if}
{/snippet}

<div
	bind:this={hostRegion}
	class="workspace-host-region relative flex h-full min-h-0 min-w-0 bg-background"
	role="region"
	aria-label={m.workspace_workspace_region()}
	tabindex="-1"
>
	<div
		class="flex min-h-0 min-w-0 flex-1 flex-col"
		inert={sidebarPresented && sidebarMetrics.mode === 'overlay'}
	>
		{#if !isMobile}
			<header
				class="relative z-50 grid h-12 shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center border-b border-border bg-background px-2"
			>
				<div class="flex min-w-0 items-center gap-1">
					{@render placementControls('main')}
				</div>
				<div class="min-w-0 max-w-[min(60vw,720px)]">{@render tabRail('main')}</div>
				<div class="flex min-w-0 items-center justify-end gap-1">
					{#if activeMain === CHAT_SURFACE_ID && selectedChat && workspaceContext.currentProject}
						<CurrentChatMenu
							{selectedChat}
							isMobileLayout={false}
							splitEnabled={splitLayout.isEnabled}
							canToggleSplitView
							{isDesktopFullscreen}
							canToggleDesktopFullscreen={Boolean(onToggleDesktopFullscreen)}
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
					{/if}
					{#if activeMain !== CHAT_SURFACE_ID && onToggleDesktopFullscreen}
						<button
							type="button"
							class="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
							onclick={onToggleDesktopFullscreen}
							aria-label={isDesktopFullscreen
								? m.workspace_exit_fullscreen()
								: m.workspace_enter_fullscreen()}
							title={isDesktopFullscreen
								? m.workspace_exit_fullscreen()
								: m.workspace_enter_fullscreen()}
						>
							{#if isDesktopFullscreen}<Minimize2 class="h-4 w-4" />{:else}<Maximize2
									class="h-4 w-4"
								/>{/if}
						</button>
					{/if}
					<AddSurfaceMenu host="main" />
					{#if !snapshot.sidebarOpen && !snapshot.manualFullscreen}
						<button
							bind:this={openSidebarButton}
							type="button"
							class="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
							onclick={() => void workspace.openSidebar()}
							aria-label={m.workspace_open_sidebar()}
							title={m.workspace_open_sidebar()}
						>
							<PanelRightOpen class="h-4 w-4" />
						</button>
					{/if}
				</div>
			</header>
		{/if}
		<div class="relative min-h-0 flex-1 overflow-hidden">
			<div
				data-workspace-surface-id={CHAT_SURFACE_ID}
				id={`main-panel-${CHAT_SURFACE_ID}`}
				role="tabpanel"
				aria-labelledby={`main-tab-${CHAT_SURFACE_ID}`}
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

	{#if sidebarPresented}
		{#if sidebarMetrics.mode === 'overlay'}
			<button
				class="absolute inset-0 z-30 bg-foreground/40"
				aria-label={m.workspace_close_sidebar()}
				onclick={() => void workspace.closeSidebar()}
			></button>
		{/if}
		<aside
			bind:this={sidebarElement}
			data-sidebar-overlay-scope={sidebarMetrics.mode === 'overlay' ? '' : undefined}
			role={sidebarMetrics.mode === 'overlay' ? 'dialog' : undefined}
			aria-modal={sidebarMetrics.mode === 'overlay' ? 'true' : undefined}
			aria-label={sidebarMetrics.mode === 'overlay' ? m.workspace_sidebar_dialog() : undefined}
			class="z-40 flex h-full min-h-0 shrink-0 flex-col border-l border-border bg-background"
			class:absolute={sidebarMetrics.mode === 'overlay'}
			class:inset-y-0={sidebarMetrics.mode === 'overlay'}
			style:inset-inline-end={sidebarMetrics.mode === 'overlay' ? '0' : undefined}
			style:width={`${sidebarMetrics.width}px`}
		>
			{#if sidebarMetrics.mode === 'push'}
				<hr
					aria-orientation="vertical"
					class="pointer-events-none absolute inset-y-0 start-0 z-40 m-0 h-full w-px border-0 bg-border"
				/>
				<input
					type="range"
					min="360"
					max={Math.round(sidebarPushMaximum)}
					value={Math.round(sidebarMetrics.width)}
					class="absolute inset-y-0 -start-[3px] z-50 w-[5px] cursor-col-resize appearance-none bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					aria-label={m.workspace_resize_sidebar_pixels({
						width: Math.round(sidebarMetrics.width),
					})}
					title={m.workspace_resize_sidebar_pixels({ width: Math.round(sidebarMetrics.width) })}
					oninput={(event) => void workspace.setSidebarWidth(Number(event.currentTarget.value))}
					onpointerdown={startResize}
					ondblclick={() => void workspace.setSidebarWidth(480)}
					onkeydown={handleResizeKey}
				/>
			{/if}
			<header
				class="relative z-50 flex h-12 shrink-0 items-center gap-1 border-b border-border bg-background px-2"
			>
				<div class="min-w-0 flex-1">{@render tabRail('sidebar')}</div>
				<AddSurfaceMenu host="sidebar" />
				{@render placementControls('sidebar')}
				<button
					type="button"
					class="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
					onclick={() => void workspace.closeSidebar()}
					aria-label={m.workspace_close_sidebar()}
					title={m.workspace_close_sidebar()}
				>
					<PanelRightClose class="h-4 w-4" />
				</button>
			</header>
			<div class="min-h-0 flex-1 overflow-hidden" aria-hidden="true"></div>
		</aside>
	{/if}

	{#each portableSurfaces as surface (surface.id)}
		{@const presentation = presentationFor(surface.id)}
		<div
			data-workspace-surface-id={surface.id}
			onfocusin={() => workspace.noteSurfaceFocus(surface.id)}
			onpointerdown={() => workspace.noteSurfaceFocus(surface.id)}
			data-sidebar-overlay-scope={presentation === 'sidebar' && sidebarMetrics.mode === 'overlay'
				? ''
				: undefined}
			id={`${presentation ?? 'hidden'}-panel-${surface.id}`}
			role="tabpanel"
			aria-labelledby={presentation === 'main' || presentation === 'sidebar'
				? `${presentation}-tab-${surface.id}`
				: undefined}
			aria-hidden={!presentation}
			inert={!presentation ||
				(presentation === 'main' && sidebarPresented && sidebarMetrics.mode === 'overlay')}
			class="absolute min-h-0 min-w-0 overflow-hidden bg-background"
			class:hidden={!presentation}
			class:z-20={presentation === 'main' || presentation === 'mobile'}
			class:z-40={presentation === 'sidebar'}
			style={surfaceStyle(presentation)}
			use:surfaceFrame={{
				registry: surfaceFrames,
				surfaceId: surface.id,
				host: presentation,
				version: workspace.frameVersion(surface.id),
				renderer: frameBridge(surface.id),
			}}
		>
			{#if presentation && workspace.attachmentErrors[surface.id]}
				<div class="grid h-full place-items-center px-6 text-center">
					<div class="max-w-sm text-sm text-status-error-foreground">
						<p>{workspace.attachmentErrors[surface.id] || m.workspace_surface_attach_failed()}</p>
						<button
							type="button"
							class="mt-3 rounded-md border border-border px-3 py-1.5 text-xs text-foreground hover:bg-accent"
							onclick={() => void workspace.retryPresentation(surface.id, presentation)}
							>{m.common_retry()}</button
						>
					</div>
				</div>
			{:else if presentation === 'mobile' && (surface.type === 'file' || (surface.type === 'singleton' && surface.kind === 'quick-git'))}
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
							visible
							onSendToChat={sendToChat}
							frameBridge={frameBridge(surface.id)}
						/>
					</div>
				</div>
			{:else if !isMobile && snapshot.dialogFileSurfaceId === surface.id}
				<!-- FileDialogHost owns the placement shell while the session occupies the dialog. -->
			{:else}
				<PortableSurfaceContent
					{surface}
					presentation={presentation ?? 'main'}
					visible={Boolean(presentation)}
					onSendToChat={sendToChat}
					frameBridge={frameBridge(surface.id)}
				/>
			{/if}
		</div>
	{/each}
</div>

{#if gitBranchActions.showNewBranchModal}
	<NewBranchModal
		currentBranch={gitQuickSummary.summaryFor(workspaceContext.currentProject?.projectPath ?? null)
			?.branch ||
			gitBranchActions.currentBranch ||
			'HEAD'}
		newBranchName={gitBranchActions.newBranchName}
		refOptions={gitBranchActions.refs}
		selectedBaseRef={gitBranchActions.newBranchBaseRef}
		isLoadingRefs={gitBranchActions.isLoadingBranches}
		isCreatingBranch={gitBranchActions.isCreatingBranch}
		onNameChange={(name) => (gitBranchActions.newBranchName = name)}
		onBaseRefChange={(ref) => (gitBranchActions.newBranchBaseRef = ref)}
		onSearchRefs={(query) => {
			const projectPath = workspaceContext.currentProject?.projectPath;
			if (projectPath) void gitBranchActions.fetchRefs(projectPath, query);
		}}
		onCreateBranch={() => {
			const projectPath = workspaceContext.currentProject?.projectPath;
			if (projectPath) void gitBranchActions.createBranch(projectPath);
		}}
		onClose={() => (gitBranchActions.showNewBranchModal = false)}
	/>
{/if}
