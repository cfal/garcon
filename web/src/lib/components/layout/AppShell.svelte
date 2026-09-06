<script lang="ts">
	import { onDestroy, onMount, tick, untrack } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import { Dialog as DialogPrimitive } from 'bits-ui';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { gotoChat } from '$lib/chat/actions/chat-navigation.js';
	import Sidebar from '../sidebar/Sidebar.svelte';
	import ResizeHandle from './ResizeHandle.svelte';
	import BottomTabBar from '$lib/components/workspace/BottomTabBar.svelte';
	import WorkspaceRoot from '$lib/components/workspace/WorkspaceRoot.svelte';
	import NotificationHost from '$lib/components/shared/NotificationHost.svelte';
	import type { MobileWorkspaceTabId } from '$lib/components/workspace/mobile-workspace-tabs';
	import type { ChatSessionRecord } from '$lib/types/chat-session';
	import {
		chatListDividerEdge,
		HOVER_CAPABLE_MEDIA_QUERY,
		type ChatListDock,
	} from '$lib/layout/desktop-layout.js';

	const lazySettings = () => import('../settings/Settings.svelte');
	const lazyScheduledPrompts = () => import('../settings/ScheduledPromptsDialog.svelte');
	const lazyPreambles = () => import('../preambles/PreamblesDialog.svelte');
	const lazyChatPreambleSelection = () => import('../preambles/ChatPreambleSelectionDialog.svelte');
	const lazySnippets = () => import('../snippets/SnippetsDialog.svelte');
	const lazyOnboardingWizard = () => import('../onboarding/OnboardingWizard.svelte');
	import {
		getNavigation,
		getChatSessions,
		getAppShell,
		getWs,
		getLocalSettings,
		getRemoteSettings,
		getMinuteClock,
		getNotifications,
		getSidebarSearch,
		getSidebarProjectCollapse,
		getGhCapability,
		getWorkspaceCoordinator,
		getTransientLayers,
		setChatDrafts,
	} from '$lib/context';
	import * as m from '$lib/paraglide/messages.js';
	import { WsConnectionNotificationPresenter } from '$lib/ws/connection-notifications';
	import { restoreChatIdForBareRoute, selectedChatIdFromRoute } from './app-shell-route';
	import { resolveAdjacentChatId, shouldSynchronizeFocusedChat } from './app-shell-chat-navigation';
	import NewChatDialog from '../chat/NewChatDialog.svelte';
	import FileDialogHost from '../files/FileDialogHost.svelte';
	import FileDirtyUnloadGuard from '../files/FileDirtyUnloadGuard.svelte';
	import WorkspaceCloseGuard from '$lib/components/workspace/WorkspaceCloseGuard.svelte';
	import { computeMobileViewportMetrics } from './mobile-viewport';
	import { ChatActionController } from '$lib/components/chat/chat-action-controller.svelte';
	import { ChatActionDialogsState } from '$lib/components/chat/chat-action-dialogs-state.svelte';
	import ChatActionDialogs from '$lib/components/chat/ChatActionDialogs.svelte';
	import ChatProjectPathDialog from '$lib/components/chat/ChatProjectPathDialog.svelte';
	import ShareChatDialog from '$lib/components/chat/ShareChatDialog.svelte';
	import SidebarTagDialog from '$lib/components/sidebar/SidebarTagDialog.svelte';
	import { buildSidebarDisplayChatIds } from '$lib/components/sidebar/sidebar-row-model';
	import type { WorkspaceWindowEdge } from '$lib/workspace/surface-types.js';
	import type { WorkspaceSplitAdmissions } from '$lib/workspace/window-geometry-policy.js';
	import { windowNodeById } from '$lib/workspace/window-tree.js';
	import { ChatDraftStore } from '$lib/chat/composer/chat-draft-store.svelte.js';
	import { AppShellChatNavigationController } from './app-shell-chat-navigation-controller.svelte.js';
	import { ChatListAutohideState } from './chat-list-autohide-state.svelte.js';
	import { transientLayerAttachment } from '$lib/workspace/transient-layer-action.js';
	import { allocateTransientLayerId } from '$lib/workspace/transient-layer-id.js';

	const navigation = getNavigation();
	const sessions = getChatSessions();
	const appShell = getAppShell();
	const ws = getWs();
	const localSettings = getLocalSettings();
	const remoteSettings = getRemoteSettings();
	const notifications = getNotifications();
	const sidebarSearch = getSidebarSearch();
	const projectCollapse = getSidebarProjectCollapse();
	const minuteClock = getMinuteClock();
	const ghCapability = getGhCapability();
	const workspace = getWorkspaceCoordinator();
	const transientLayers = getTransientLayers();
	const hoverCapability = new MediaQuery(HOVER_CAPABLE_MEDIA_QUERY);
	const chatDrafts = new ChatDraftStore();
	setChatDrafts(chatDrafts);
	const wsConnectionNotifications = new WsConnectionNotificationPresenter({
		notifications,
	});
	const chatActionDialogs = new ChatActionDialogsState();
	let mobileSidebarFocusReturnTarget: HTMLElement | null = null;
	const mobileSidebarLayer = transientLayerAttachment({
		registry: transientLayers,
		id: allocateTransientLayerId('mobile-sidebar'),
		kind: 'sidebar-overlay',
		modality: 'main-inert',
		onEscape: () => {
			closeMobileSidebar();
			return true;
		},
		restoreFocus: restoreMobileSidebarFocus,
	});
	const chatActionController = new ChatActionController({
		get chats() {
			return sessions.orderedChats;
		},
		get selectedChatId() {
			return sessions.selectedChatId;
		},
		onQuietRefresh: quietRefresh,
		onSelectChat: handleChatSelect,
		onNewChat: handleNewChat,
		onDeleteChat: handleChatDelete,
		onRenameChat: handleChatRenamed,
		onProjectPathUpdated: handleChatProjectPathUpdated,
		onUpsertServerChat: (entry) => sessions.upsertServerChat(entry),
		onReloadChat: handleReloadChat,
		notifyError(message) {
			notifications.error(message);
		},
		requestComposerFocus() {
			appShell.requestComposerFocus();
		},
		requestSidebarRecenter() {
			appShell.requestSidebarRecenterToSelected();
		},
	});

	let isMobile = $derived(workspace.isMobile);
	let viewportWidth = $state<number>();
	const mobileBreakpointMatches = $derived(
		viewportWidth === undefined ? undefined : viewportWidth <= 768,
	);
	let mobileAppHeight = $state<number | null>(null);
	let mobileViewportBaselineHeight = $state<number | null>(null);
	let mobileKeyboardVisible = $state(false);
	let reloadSelectedChatFn = $state<((chatId: string) => Promise<void>) | null>(null);
	const workspaceFullscreen = $derived(
		!isMobile && workspace.layout.snapshot.fullscreenWindowId !== null,
	);
	const newWindowEdges = $derived<WorkspaceSplitAdmissions>(
		workspace.resolveSplitAdmissions(workspace.currentWindowId),
	);
	const hideLeftSidebar = $derived(workspaceFullscreen);
	const chatListAutohideActive = $derived(
		!isMobile && !hideLeftSidebar && localSettings.chatListAutohide && hoverCapability.current,
	);
	const chatListAutohide = new ChatListAutohideState({
		get active() {
			return chatListAutohideActive;
		},
	});
	let desktopChatListPanelElement = $state<HTMLElement | null>(null);
	let chatListRevealTrigger = $state<HTMLButtonElement | null>(null);
	const mobileActiveDescriptor = $derived(
		workspace.layout.surface(workspace.layout.snapshot.mobileActiveSurfaceId),
	);
	const mobileActiveTab = $derived.by<MobileWorkspaceTabId>(() => {
		const surface = mobileActiveDescriptor;
		if (surface?.type === 'terminal' || surface?.type === 'terminal-launcher') return 'terminal';
		if (surface?.type === 'chat') return 'chat';
		if (surface?.type === 'singleton') {
			if (surface.kind === 'pull-requests') return 'pull-requests';
			if (surface.kind === 'chat-map') return 'chat-map';
			if (surface.kind === 'git' || surface.kind === 'files') {
				return surface.kind;
			}
		}
		return 'chat';
	});
	const mobileTransientSurface = $derived(
		mobileActiveDescriptor?.type === 'file' ||
			(mobileActiveDescriptor?.type === 'singleton' &&
				(mobileActiveDescriptor.kind === 'commit' ||
					mobileActiveDescriptor.kind === 'git-history' ||
					mobileActiveDescriptor.kind === 'git-compare')),
	);
	let notificationDesktopInlineStartPx = $derived(
		!isMobile &&
			!hideLeftSidebar &&
			!chatListAutohideActive &&
			localSettings.chatListDock === 'left'
			? localSettings.sidebarWidth + 16
			: 16,
	);
	const sidebarMounted = $derived(!isMobile || appShell.sidebarOpen);
	const displayedSidebarChatIds = $derived.by(() =>
		buildSidebarDisplayChatIds({
			displayedChats: sidebarSearch.filteredChats,
			grouping: localSettings.sidebarGrouping,
			currentTime: minuteClock.currentTime,
			inactivityDuration: localSettings.sidebarInactivityDuration,
			sortMode: localSettings.sidebarSortMode,
			pinnedInsertPosition: remoteSettings.snapshot?.ui?.pinnedInsertPosition ?? 'top',
			groupNestedProjectPaths: localSettings.sidebarGroupNestedProjectPaths,
			collapsedProjectKeys: projectCollapse.collapsedProjectKeys,
		}),
	);
	const chatNavigation = new AppShellChatNavigationController({
		get routeChatId() {
			return page.params.id as string | undefined;
		},
		get selectedChatId() {
			return sessions.selectedChatId;
		},
		get isLoadingChats() {
			return sessions.isLoadingChats;
		},
		get currentWindowId() {
			return workspace.currentWindowId;
		},
		hasChat: (chatId) => sessions.hasChat(chatId),
		showChatInCurrentWindow: (chatId) => workspace.showChatInCurrentWindow(chatId),
		setSelectedChatId: (chatId) => sessions.setSelectedChatId(chatId),
		navigateToChat: gotoChat,
		navigateToBareRoute: () => goto('/'),
		requestComposerFocus: () => appShell.requestComposerFocus(),
		requestSidebarRecenter: () => appShell.requestSidebarRecenterToSelected(),
		reportOpenError: (error) => {
			notifications.error(error instanceof Error ? error.message : m.workspace_open_failed());
		},
		reportDeleteError: (error) => {
			notifications.error(
				error instanceof Error ? error.message : m.notifications_delete_chat_failed(),
			);
		},
	});

	$effect(() => {
		const chatId = page.params.id as string | undefined;
		const selectedChatId = selectedChatIdFromRoute(page.url.pathname, chatId);
		if (selectedChatId === undefined) return;
		untrack(() => chatNavigation.handleRouteChat(selectedChatId));
	});

	$effect(() => {
		const lastSelectedChatId = sessions.lastSelectedChatId;
		const target = restoreChatIdForBareRoute({
			pathname: page.url.pathname,
			routeChatId: page.params.id as string | undefined,
			isLoadingChats: sessions.isLoadingChats,
			lastSelectedChatId,
			lastSelectedChatExists: lastSelectedChatId ? sessions.hasChat(lastSelectedChatId) : false,
			selectedChatId: sessions.selectedChatId,
		});
		if (!target) return;
		untrack(() => void chatNavigation.showChatInCurrentWindow(target, { navigate: true }));
	});

	$effect(() => {
		const currentWindowId = workspace.currentWindowId;
		const currentSnapshot = workspace.layout.snapshot;
		const resolvedActiveId = isMobile
			? currentSnapshot.mobileActiveSurfaceId
			: windowNodeById(currentSnapshot.desktopRoot, currentWindowId)?.tabs.activeId;
		const surface = resolvedActiveId ? currentSnapshot.surfaces[resolvedActiveId] : null;
		const chatId = surface?.type === 'chat' ? surface.chatId : null;
		if (
			!chatId ||
			!shouldSynchronizeFocusedChat({
				focusedWindowId: currentWindowId,
				focusedChatId: chatId,
				focusedChatExists: sessions.hasChat(chatId),
				selectedChatId: sessions.selectedChatId,
				pendingChatTarget: chatNavigation.pendingChatTarget,
				pendingWindowId: chatNavigation.pendingWindowId,
			})
		) {
			return;
		}
		untrack(() => void chatNavigation.synchronizeFocusedChat(chatId));
	});

	$effect(() => {
		const selected = sessions.selectedChat;
		if (!selected || selected.status === 'draft') return;
		const chatId = selected.id;
		untrack(() => sessions.rememberSelectedChat(chatId));
	});

	$effect(() => {
		const matches = mobileBreakpointMatches;
		if (matches === undefined) return;
		let cancelled = false;
		let retryTimer: ReturnType<typeof setTimeout> | null = null;

		function transitionBreakpoint(matches: boolean): Promise<void> {
			if (matches) return workspace.enterMobilePresentation();
			const transition = workspace.exitMobilePresentation();
			appShell.setSidebarOpen(false);
			return transition;
		}

		void untrack(() => transitionBreakpoint(matches)).catch(() => {
			if (cancelled) return;
			retryTimer = setTimeout(() => {
				retryTimer = null;
				if (cancelled) return;
				void untrack(() => transitionBreakpoint(matches)).catch(() => undefined);
			}, 0);
		});

		return () => {
			cancelled = true;
			if (retryTimer) clearTimeout(retryTimer);
		};
	});

	// Tracks virtual keyboard height via visualViewport for mobile layout.
	$effect(() => {
		if (typeof window === 'undefined' || !window.visualViewport) return;
		const vv = window.visualViewport;
		let frameId: number | null = null;

		function applyViewportMetrics() {
			frameId = null;
			const metrics = computeMobileViewportMetrics({
				visualViewportHeight: vv.height,
				visualViewportOffsetTop: vv.offsetTop,
				windowInnerHeight: window.innerHeight,
				baselineAppHeight: mobileViewportBaselineHeight,
				previousAppHeight: mobileAppHeight,
			});
			mobileAppHeight = metrics.appHeight;
			mobileKeyboardVisible = metrics.keyboardVisible;
			if (!metrics.keyboardVisible) {
				mobileViewportBaselineHeight = metrics.appHeight;
			}
			appShell.keyboardHeight = metrics.keyboardHeight;
			document.documentElement.style.setProperty('--app-height', `${metrics.appHeight}px`);
			document.documentElement.style.setProperty(
				'--app-viewport-offset-top',
				`${metrics.viewportOffsetTop}px`,
			);
			document.documentElement.style.setProperty(
				'--app-viewport-center-y',
				`${metrics.viewportCenterY}px`,
			);
		}

		function scheduleViewportMetrics() {
			if (frameId !== null) return;
			frameId = requestAnimationFrame(applyViewportMetrics);
		}

		scheduleViewportMetrics();
		vv.addEventListener('resize', scheduleViewportMetrics);
		vv.addEventListener('scroll', scheduleViewportMetrics);
		return () => {
			if (frameId !== null) cancelAnimationFrame(frameId);
			vv.removeEventListener('resize', scheduleViewportMetrics);
			vv.removeEventListener('scroll', scheduleViewportMetrics);
		};
	});

	function quietRefresh() {
		return sessions.quietRefreshChats();
	}

	$effect(() => {
		const status = ws.connectionStatus;
		return untrack(() => wsConnectionNotifications.observe(status));
	});

	onMount(() => {
		// Starts the first chat-list refresh early so the sidebar populates even
		// before the WS connection opens.
		void sessions.refreshChats();
	});

	function handleChatSelect(chatId: string): void {
		void chatNavigation.showChatInCurrentWindow(chatId, { navigate: true });
	}

	function handleOpenChatInNewWindow(chatId: string, edge?: WorkspaceWindowEdge): void {
		void workspace.openChatInNewWindow(chatId, undefined, edge).catch((error) => {
			notifications.error(error instanceof Error ? error.message : m.workspace_open_failed());
		});
	}

	function handleNewChat() {
		if (isMobile) {
			appShell.setSidebarOpen(false);
		}
		appShell.openNewChatDialog();
	}

	// Navigates to the chat above or below the currently selected one.
	// No-op when no chat is selected or at the list boundary.
	function navigateChatAdjacent(offset: -1 | 1) {
		const targetId = resolveAdjacentChatId({
			selectedChatId: sessions.selectedChatId,
			displayedChatIds: sidebarMounted ? displayedSidebarChatIds : null,
			fallbackOrder: sessions.order,
			offset,
		});
		if (!targetId) return;
		void chatNavigation.showChatInCurrentWindow(targetId, { navigate: true });
	}

	// Applies the same store mutations the ChatSessionDeletedWsMessage handler
	// would apply once the server broadcast arrives. Running it eagerly lets
	// the sidebar and URL update without waiting for the HTTP round-trip.
	function locallyDeleteChat(chatId: string) {
		if (!sessions.hasChat(chatId)) return;
		const wasSelected = sessions.selectedChatId === chatId;
		const index = sessions.order.indexOf(chatId);
		const neighborId = sessions.order[index - 1] ?? sessions.order[index + 1] ?? null;
		void chatNavigation.reconcileDeletedChat({
			chatId,
			wasSelected,
			neighborId,
			removeLocal: () => {
				sessions.removeChat(chatId);
				chatDrafts.discardChat(chatId);
			},
			clearPresentation: () => workspace.clearDeletedChat(chatId),
		});
	}

	function handleChatDelete(chatId: string) {
		locallyDeleteChat(chatId);
		return sessions.deleteRemoteChat(chatId);
	}

	async function handleChatRenamed(chatId: string, newTitle: string): Promise<void> {
		await sessions.renameChat(chatId, newTitle);
	}

	function handleRegisterReload(fn: (chatId: string) => Promise<void>): void {
		reloadSelectedChatFn = fn;
	}

	async function handleReloadChat(chatId: string): Promise<void> {
		if (!reloadSelectedChatFn) {
			throw new Error(m.sidebar_chats_reload_failed());
		}
		await reloadSelectedChatFn(chatId);
		await quietRefresh();
	}

	function handleMobileTabChange(tab: MobileWorkspaceTabId) {
		if (tab === 'chat') {
			void workspace.focusChat();
			return;
		}
		if (tab !== 'terminal') {
			void workspace.focusMobileSingleton(tab);
			return;
		}
		void workspace.focusMostRecentTerminalOrCreate().catch((error) => {
			notifications.error(error instanceof Error ? error.message : m.terminal_create_failed());
		});
	}

	function toggleMobileSidebar() {
		if (appShell.sidebarOpen) {
			closeMobileSidebar();
			return;
		}
		transientLayers.open('main-inert', () => appShell.setSidebarOpen(true));
	}

	function closeMobileSidebar() {
		appShell.setSidebarOpen(false);
	}

	function captureMobileSidebarFocusReturnTarget(): void {
		mobileSidebarFocusReturnTarget =
			document.activeElement instanceof HTMLElement ? document.activeElement : null;
	}

	function restoreMobileSidebarFocus(): void {
		const target = mobileSidebarFocusReturnTarget;
		mobileSidebarFocusReturnTarget = null;
		if (target?.isConnected) target.focus({ preventScroll: true });
	}

	function handleMobileSidebarCloseAutoFocus(event: Event): void {
		event.preventDefault();
		restoreMobileSidebarFocus();
	}

	function handleMobileChatSelect(chatId: string): void {
		handleChatSelect(chatId);
		closeMobileSidebar();
	}

	function handleChatProjectPathUpdated(
		chatId: string,
		patch: { projectPath: string; effectiveProjectKey: string },
	): void {
		sessions.patchChat(chatId, patch);
	}

	function requestDeleteChat(chat: ChatSessionRecord): void {
		chatActionDialogs.requestDelete(chat, m.sidebar_chats_new_chat());
	}

	function requestRenameChat(chat: ChatSessionRecord): void {
		chatActionDialogs.requestRename(chat, m.sidebar_chats_new_chat());
	}

	function requestDetailsChat(chat: ChatSessionRecord): void {
		chatActionDialogs.requestDetails(chat, m.sidebar_chats_new_chat());
		void chatActionController.loadDetails(chat.id, chatActionDialogs);
	}

	function requestShareChat(chat: ChatSessionRecord): void {
		chatActionDialogs.requestShare(chat, m.sidebar_chats_new_chat());
	}

	function requestProjectPathChat(chat: ChatSessionRecord): void {
		chatActionDialogs.requestProjectPath(chat, m.sidebar_chats_new_chat());
	}

	function requestTagsChat(chat: ChatSessionRecord): void {
		chatActionDialogs.requestTags(chat, m.sidebar_chats_new_chat());
	}

	async function confirmChatTags(chatId: string, tags: string[]): Promise<void> {
		await chatActionController.updateTags(chatId, tags);
		chatActionDialogs.closeTagDialog();
	}

	const workspaceChatActions = {
		requestDelete: requestDeleteChat,
		requestRename: requestRenameChat,
		requestDetails: requestDetailsChat,
		requestShare: requestShareChat,
		requestProjectPath: requestProjectPathChat,
		configurePreambles(chat: ChatSessionRecord, transcriptViewId: string): void {
			appShell.openChatPreambleSelection(chat.id, transcriptViewId);
		},
		fork(chat: ChatSessionRecord): void {
			void chatActionController.forkChat(chat.id);
		},
		reload(chat: ChatSessionRecord): void {
			void chatActionController.reloadChat(chat.id);
		},
	};

	onMount(() => {
		const unsubscribers = [
			appShell.onNewChatRequested(() => handleNewChat()),
			appShell.onRenameSelectedChatRequested(() => {
				const selected = sessions.selectedChat;
				if (selected) requestRenameChat(selected);
			}),
			appShell.onDeleteSelectedChatRequested(() => {
				const selected = sessions.selectedChat;
				if (selected) requestDeleteChat(selected);
			}),
			navigation.onNavigateChatAboveRequested(() => navigateChatAdjacent(-1)),
			navigation.onNavigateChatBelowRequested(() => navigateChatAdjacent(1)),
		];
		return () => {
			for (const unsubscribe of unsubscribers) unsubscribe();
		};
	});

	onMount(() => chatDrafts.mountPersistenceLifecycle());
	onDestroy(() => chatDrafts.destroy());

	function handleChatListAutohideChange(enabled: boolean): void {
		if (enabled) chatListAutohide.reveal();
		else chatListAutohide.collapse();
	}

	function handleDesktopChatListFocus(): void {
		workspace.noteChatListFocus();
	}

	function handleDesktopChatListKeydown(event: KeyboardEvent): void {
		if (event.key !== 'Escape' || !chatListAutohide.revealed) return;
		event.preventDefault();
		event.stopPropagation();
		chatListAutohide.collapse();
		chatListRevealTrigger?.focus();
	}

	async function revealChatListFromTrigger(): Promise<void> {
		chatListAutohide.reveal();
		await tick();
		if (chatListAutohide.revealed) desktopChatListPanelElement?.focus();
	}

	function collapseAutohiddenChatListOnWorkspaceInteraction(node: HTMLElement): {
		destroy(): void;
	} {
		function handlePointerEnter(): void {
			chatListAutohide.collapseUnlessEngaged(desktopChatListPanelElement);
		}

		function handlePointerDown(): void {
			if (chatListAutohide.active) chatListAutohide.collapse();
		}

		node.addEventListener('pointerenter', handlePointerEnter);
		node.addEventListener('pointerdown', handlePointerDown);
		return {
			destroy() {
				node.removeEventListener('pointerenter', handlePointerEnter);
				node.removeEventListener('pointerdown', handlePointerDown);
			},
		};
	}
</script>

{#snippet sidebarContent(isMobile: boolean, onChatSelect: (chatId: string) => void)}
	<Sidebar
		chats={sessions.orderedChats}
		selectedChatId={sessions.selectedChatId}
		isLoading={sessions.isLoadingChats}
		{isMobile}
		{onChatSelect}
		onNewChat={handleNewChat}
		onLocallyDeleteChat={locallyDeleteChat}
		onQuietRefresh={quietRefresh}
		onRequestDeleteChat={requestDeleteChat}
		onRequestRenameChat={requestRenameChat}
		onTogglePinned={(id) => chatActionController.togglePinned(id)}
		onToggleArchive={(id) => chatActionController.toggleArchive(id)}
		onShowDetails={requestDetailsChat}
		onForkChat={(id) => chatActionController.forkChat(id)}
		onShareChat={requestShareChat}
		onManageTags={requestTagsChat}
		onOpenChatInNewWindow={isMobile ? undefined : handleOpenChatInNewWindow}
		chatListAutohideAvailable={hoverCapability.current}
		onChatListAutohideChange={handleChatListAutohideChange}
		onShowScheduledPrompts={() => appShell.openScheduledPrompts()}
		onShowPreambles={() => appShell.openPreambles()}
		onShowSettings={() => appShell.openSettings()}
		{newWindowEdges}
	/>
{/snippet}

{#snippet desktopChatList(dock: ChatListDock)}
	{@const dividerEdge = chatListDividerEdge(dock)}
	{@const panelHidden = hideLeftSidebar || chatListAutohide.collapsed}
	<div
		data-workspace-chat-list
		onfocusin={handleDesktopChatListFocus}
		onpointerdown={() => workspace.noteChatListFocus()}
		onpointerenter={() => chatListAutohide.reveal()}
		onkeydown={handleDesktopChatListKeydown}
		class={[
			'relative z-50 h-full shrink-0',
			chatListAutohide.active && !hideLeftSidebar ? 'overflow-visible' : 'overflow-hidden',
		]}
		class:order-first={dock === 'left'}
		class:order-last={dock === 'right'}
		class:pointer-events-none={hideLeftSidebar}
		style:width={hideLeftSidebar || chatListAutohide.active
			? '0px'
			: `${localSettings.sidebarWidth}px`}
		aria-hidden={hideLeftSidebar}
		inert={hideLeftSidebar}
	>
		{#if chatListAutohide.active}
			<button
				bind:this={chatListRevealTrigger}
				type="button"
				class="absolute inset-y-0 z-30 w-2.5 bg-transparent outline-none hover:bg-accent/30 focus-visible:bg-accent/30 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
				class:start-0={dock === 'left'}
				class:end-0={dock === 'right'}
				onclick={() => void revealChatListFromTrigger()}
				aria-controls="desktop-chat-list-panel"
				aria-expanded={chatListAutohide.revealed}
				aria-label={m.layout_show_chat_list()}
			></button>
		{/if}
		<div
			bind:this={desktopChatListPanelElement}
			id="desktop-chat-list-panel"
			data-workspace-chat-list-panel
			class={[
				'h-full border-border bg-card outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
				chatListAutohide.active && 'absolute inset-y-0 z-40 shadow-2xl',
				chatListAutohide.active &&
					!localSettings.reduceMotion &&
					'transition-transform duration-150',
				chatListAutohide.collapsed && dock === 'left' && '-translate-x-full',
				chatListAutohide.collapsed && dock === 'right' && 'translate-x-full',
			]}
			class:start-0={chatListAutohide.active && dock === 'left'}
			class:end-0={chatListAutohide.active && dock === 'right'}
			class:border-s={dividerEdge === 'start' && !hideLeftSidebar}
			class:border-e={dividerEdge === 'end' && !hideLeftSidebar}
			style:width={chatListAutohide.active ? `${localSettings.sidebarWidth}px` : undefined}
			tabindex="-1"
			aria-hidden={panelHidden}
			inert={panelHidden}
		>
			{@render sidebarContent(false, handleChatSelect)}
			{#if !hideLeftSidebar}
				<ResizeHandle
					edge={dividerEdge}
					width={localSettings.sidebarWidth}
					onResize={(width) => localSettings.set('sidebarWidth', width)}
				/>
			{/if}
		</div>
	</div>
{/snippet}

<svelte:window bind:innerWidth={viewportWidth} />

<div
	class="flex w-screen overflow-hidden bg-background text-foreground"
	class:mobile-shell={isMobile}
	class:h-dvh={!isMobile}
	class:flex-col={isMobile}
>
	{#if isMobile}
		<DialogPrimitive.Root
			open={appShell.sidebarOpen}
			onOpenChange={(open) => {
				if (!open) closeMobileSidebar();
			}}
		>
			<DialogPrimitive.Overlay
				class="fixed inset-0 z-40 transient-backdrop"
				onclick={closeMobileSidebar}
			/>
			<DialogPrimitive.Content
				data-workspace-chat-list
				aria-label={m.layout_chat_list()}
				class="fixed inset-y-0 left-0 z-50 h-full w-[85%] max-w-sm bg-card shadow-2xl"
				onOpenAutoFocus={captureMobileSidebarFocusReturnTarget}
				onCloseAutoFocus={handleMobileSidebarCloseAutoFocus}
				onfocusin={() => workspace.noteChatListFocus()}
				onpointerdown={() => workspace.noteChatListFocus()}
				{@attach mobileSidebarLayer}
			>
				{@render sidebarContent(true, handleMobileChatSelect)}
			</DialogPrimitive.Content>
		</DialogPrimitive.Root>
	{/if}

	<div class="flex min-h-0 min-w-0 flex-1 overflow-hidden">
		{#if !isMobile}
			{@render desktopChatList(localSettings.chatListDock)}
		{/if}
		<div
			data-workspace-content
			class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
			use:collapseAutohiddenChatListOnWorkspaceInteraction
		>
			<div class="min-h-0 flex-1 overflow-hidden">
				<WorkspaceRoot
					{isMobile}
					onRegisterReload={handleRegisterReload}
					chatActions={workspaceChatActions}
				/>
			</div>
			{#if isMobile && !mobileKeyboardVisible && !mobileTransientSurface}
				<BottomTabBar
					activeItem={mobileActiveTab}
					pullRequestsAvailable={ghCapability.available}
					onTabChange={handleMobileTabChange}
					onMenuClick={toggleMobileSidebar}
				/>
			{/if}
		</div>
	</div>
</div>

<ChatActionDialogs
	chatDeleteConfirmation={chatActionDialogs.chatDeleteConfirmation}
	onCancelDelete={() => chatActionDialogs.clearDeleteConfirmation()}
	onConfirmDelete={() => {
		void chatActionController.confirmDelete(chatActionDialogs);
	}}
	chatRenameConfirmation={chatActionDialogs.chatRenameConfirmation}
	onCancelRename={() => chatActionDialogs.clearRename()}
	onConfirmRename={(newName) => {
		void chatActionController.confirmRename(chatActionDialogs, newName);
	}}
	chatDetailsDialog={chatActionDialogs.chatDetailsDialog}
	onCloseDetails={() => chatActionDialogs.closeDetails()}
/>

<ChatProjectPathDialog
	projectPathDialog={chatActionDialogs.chatProjectPathDialog}
	projectBasePath={appShell.projectBasePath}
	{isMobile}
	onClose={() => chatActionDialogs.closeProjectPathDialog()}
	onConfirm={(chatId, projectPath) => chatActionController.updateProjectPath(chatId, projectPath)}
/>

<SidebarTagDialog
	tagDialog={chatActionDialogs.tagDialog}
	allKnownTags={sidebarSearch.allKnownTags}
	onClose={() => chatActionDialogs.closeTagDialog()}
	onSave={confirmChatTags}
/>

<ShareChatDialog
	chatId={chatActionDialogs.shareChatDialog?.chatId ?? null}
	onClose={() => chatActionDialogs.closeShareDialog()}
/>

<NewChatDialog />
<FileDialogHost />
<FileDirtyUnloadGuard />
<WorkspaceCloseGuard />
<NotificationHost {notifications} desktopInlineStartPx={notificationDesktopInlineStartPx} />

{#if appShell.showSettings}
	{#await lazySettings() then { default: Settings }}
		<Settings />
	{/await}
{/if}

{#if appShell.showScheduledPrompts}
	{#await lazyScheduledPrompts() then { default: ScheduledPromptsDialog }}
		<ScheduledPromptsDialog />
	{/await}
{/if}

{#if appShell.showPreambles}
	{#await lazyPreambles() then { default: PreamblesDialog }}
		<PreamblesDialog />
	{/await}
{/if}

{#if appShell.chatPreambleSelectionTarget}
	{#await lazyChatPreambleSelection() then { default: ChatPreambleSelectionDialog }}
		<ChatPreambleSelectionDialog />
	{/await}
{/if}

{#if appShell.showSnippets}
	{#await lazySnippets() then { default: SnippetsDialog }}
		<SnippetsDialog />
	{/await}
{/if}

{#if appShell.showOnboardingWizard}
	{#await lazyOnboardingWizard() then { default: OnboardingWizard }}
		<OnboardingWizard />
	{/await}
{/if}
