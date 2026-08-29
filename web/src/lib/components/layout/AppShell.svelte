<script lang="ts">
	import { onDestroy, onMount, untrack } from 'svelte';
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
	import { chatListDividerEdge, type ChatListDock } from '$lib/layout/desktop-layout.js';

	const lazySettings = () => import('../settings/Settings.svelte');
	const lazyScheduledPrompts = () => import('../settings/ScheduledPromptsDialog.svelte');
	const lazySnippets = () => import('../snippets/SnippetsDialog.svelte');
	import {
		getNavigation,
		getChatSessions,
		getAppShell,
		getWs,
		getLocalSettings,
		getNotifications,
		getSidebarSearch,
		getSidebarProjectCollapse,
		getGhCapability,
		getTerminalRegistry,
		getWorkspaceCoordinator,
		setChatDrafts,
	} from '$lib/context';
	import * as m from '$lib/paraglide/messages.js';
	import { WsConnectionNotificationPresenter } from '$lib/ws/connection-notifications';
	import { restoreChatIdForBareRoute, selectedChatIdFromRoute } from './app-shell-route';
	import {
		resolveAdjacentChatId,
		shouldSynchronizeFocusedChat,
	} from './app-shell-chat-navigation';
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
	import { TERMINAL_SESSION_LIMIT } from '$shared/terminal';
	import type { PortableSingletonKind, WorkspaceWindowEdge } from '$lib/workspace/surface-types.js';
	import { windowNodeById } from '$lib/workspace/window-tree.js';
	import type { WorkspaceNewWindowActions } from '$lib/workspace/workspace-new-window-actions.js';
	import { ChatDraftStore } from '$lib/chat/composer/chat-draft-store.svelte.js';

	const navigation = getNavigation();
	const sessions = getChatSessions();
	const appShell = getAppShell();
	const ws = getWs();
	const localSettings = getLocalSettings();
	const notifications = getNotifications();
	const sidebarSearch = getSidebarSearch();
	const projectCollapse = getSidebarProjectCollapse();
	const ghCapability = getGhCapability();
	const terminals = getTerminalRegistry();
	const workspace = getWorkspaceCoordinator();
	const chatDrafts = new ChatDraftStore();
	setChatDrafts(chatDrafts);
	const wsConnectionNotifications = new WsConnectionNotificationPresenter({
		notifications,
	});
	const chatActionDialogs = new ChatActionDialogsState();
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
	let mobileAppHeight = $state<number | null>(null);
	let mobileViewportBaselineHeight = $state<number | null>(null);
	let mobileKeyboardVisible = $state(false);
	let reloadSelectedChatFn = $state<((chatId: string) => Promise<void>) | null>(null);
	const workspaceFullscreen = $derived(
		!isMobile && workspace.layout.snapshot.fullscreenWindowId !== null,
	);
	const focusedWindowKind = $derived(workspace.focusedWindowActiveKind);
	const hideLeftForGit = $derived(
		!isMobile &&
			localSettings.hideChatListWhenGitFocused &&
			(focusedWindowKind === 'git' ||
				focusedWindowKind === 'git-history' ||
				focusedWindowKind === 'git-compare'),
	);
	const hideLeftSidebar = $derived(workspaceFullscreen || hideLeftForGit);
	const newWindowActions = $derived.by<WorkspaceNewWindowActions>(() => ({
		windowLimitReached: !workspace.canOpenNewWindow,
		terminalLimitReached: terminals.orderedSessions.length >= TERMINAL_SESSION_LIMIT,
		singletonKinds: (
			[
				'git',
				'git-history',
				'git-compare',
				'pull-requests',
				'files',
				'commit',
			] as const satisfies readonly PortableSingletonKind[]
		).filter(
			(kind) => kind !== 'pull-requests' || !ghCapability.hasChecked || ghCapability.available,
		),
		createTerminal(): void {
			void workspace.createTerminalInNewWindow().catch((error) => {
				notifications.error(error instanceof Error ? error.message : m.terminal_create_failed());
			});
		},
		openSingleton(kind): void {
			void workspace.openSingletonInNewWindow(kind).catch((error) => {
				notifications.error(error instanceof Error ? error.message : m.workspace_open_failed());
			});
		},
	}));
	const mobileActiveDescriptor = $derived(
		workspace.layout.surface(workspace.layout.snapshot.mobileActiveSurfaceId),
	);
	const mobileActiveTab = $derived.by<MobileWorkspaceTabId>(() => {
		const surface = mobileActiveDescriptor;
		if (surface?.type === 'terminal' || surface?.type === 'terminal-launcher') return 'terminal';
		if (surface?.type === 'chat') return 'chat';
		if (surface?.type === 'singleton') {
			if (surface.kind === 'pull-requests') return 'pull-requests';
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
		!isMobile && !hideLeftSidebar && localSettings.chatListDock === 'left'
			? localSettings.sidebarWidth + 16
			: 16,
	);
	const sidebarMounted = $derived(!isMobile || appShell.sidebarOpen);
	const displayedSidebarChatIds = $derived.by(() =>
		buildSidebarDisplayChatIds({
			displayedChats: sidebarSearch.filteredChats,
			groupByProject: localSettings.sidebarGroupByProject,
			groupNestedProjectPaths: localSettings.sidebarGroupNestedProjectPaths,
			collapsedProjectKeys: projectCollapse.collapsedProjectKeys,
		}),
	);
	let chatNavigationGeneration = 0;
	let pendingChatTarget = $state<string | null>(null);

	$effect(() => {
		const chatId = page.params.id as string | undefined;
		const selectedChatId = selectedChatIdFromRoute(page.url.pathname, chatId);
		if (selectedChatId === undefined) return;
		untrack(() => {
			if (selectedChatId) {
				void showChatInCurrentWindow(selectedChatId, { navigate: false });
			} else if (!pendingChatTarget) {
				sessions.setSelectedChatId(null);
			}
		});
	});

	$effect(() => {
		const target = restoreChatIdForBareRoute({
			pathname: page.url.pathname,
			routeChatId: page.params.id as string | undefined,
			isLoadingChats: sessions.isLoadingChats,
			lastSelectedChatId: sessions.lastSelectedChatId,
			selectedChatId: sessions.selectedChatId,
		});
		if (!target) return;
		untrack(() => void showChatInCurrentWindow(target, { navigate: true }));
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
				focusedChatId: chatId,
				focusedChatExists: sessions.hasChat(chatId),
				selectedChatId: sessions.selectedChatId,
				pendingChatTarget,
			})
		) {
			return;
		}
		untrack(() => void synchronizeFocusedChat(chatId));
	});

	$effect(() => {
		const selected = sessions.selectedChat;
		if (!selected || selected.status === 'draft') return;
		const chatId = selected.id;
		untrack(() => sessions.rememberSelectedChat(chatId));
	});

	$effect(() => {
		if (typeof window === 'undefined') return;
		const mql = window.matchMedia('(max-width: 768px)');

		function applyBreakpoint(matches: boolean): void {
			if (matches) void workspace.enterMobilePresentation();
			else {
				void workspace.exitMobilePresentation();
				appShell.setSidebarOpen(false);
			}
		}

		applyBreakpoint(mql.matches);

		function onChange(e: MediaQueryListEvent) {
			applyBreakpoint(e.matches);
		}

		function onResize(): void {
			applyBreakpoint(mql.matches);
		}

		mql.addEventListener('change', onChange);
		window.addEventListener('resize', onResize);
		return () => {
			mql.removeEventListener('change', onChange);
			window.removeEventListener('resize', onResize);
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

	async function showChatInCurrentWindow(
		chatId: string,
		options: { navigate: boolean },
	): Promise<void> {
		const generation = ++chatNavigationGeneration;
		pendingChatTarget = chatId;
		try {
			await workspace.showChatInCurrentWindow(chatId);
			if (generation !== chatNavigationGeneration) return;
			sessions.setSelectedChatId(chatId);
			if (options.navigate && page.params.id !== chatId) await gotoChat(chatId);
			if (generation !== chatNavigationGeneration) return;
			appShell.requestComposerFocus();
		} catch (error) {
			if (generation === chatNavigationGeneration) {
				notifications.error(error instanceof Error ? error.message : m.workspace_open_failed());
			}
		} finally {
			if (generation === chatNavigationGeneration) pendingChatTarget = null;
		}
	}

	async function synchronizeFocusedChat(chatId: string): Promise<void> {
		const generation = ++chatNavigationGeneration;
		pendingChatTarget = chatId;
		try {
			sessions.setSelectedChatId(chatId);
			if (page.params.id !== chatId) await gotoChat(chatId);
			if (generation === chatNavigationGeneration) appShell.requestComposerFocus();
		} finally {
			if (generation === chatNavigationGeneration) pendingChatTarget = null;
		}
	}

	function handleChatSelect(chatId: string): void {
		void showChatInCurrentWindow(chatId, { navigate: true });
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
		void showChatInCurrentWindow(targetId, { navigate: true });
	}

	// Applies the same store mutations the ChatSessionDeletedWsMessage handler
	// would apply once the server broadcast arrives. Running it eagerly lets
	// the sidebar and URL update without waiting for the HTTP round-trip.
	function locallyDeleteChat(chatId: string) {
		if (!sessions.hasChat(chatId)) return;
		const wasSelected = sessions.selectedChatId === chatId;
		const index = sessions.order.indexOf(chatId);
		const neighborId = sessions.order[index - 1] ?? sessions.order[index + 1] ?? null;
		sessions.removeChat(chatId);
		chatDrafts.discardChat(chatId);
		void workspace.clearDeletedChat(chatId).then(() => {
			if (!wasSelected) return;
			if (neighborId) {
				void showChatInCurrentWindow(neighborId, { navigate: true });
				return;
			}
			chatNavigationGeneration += 1;
			pendingChatTarget = null;
			sessions.setSelectedChatId(null);
			void goto('/');
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
		if (tab === 'git') {
			void workspace.focusMobileSingleton('git');
			return;
		}
		if (tab === 'pull-requests') {
			void workspace.focusMobileSingleton('pull-requests');
			return;
		}
		if (tab === 'files') {
			void workspace.focusMobileSingleton('files');
			return;
		}
		void workspace.focusMostRecentTerminalOrCreate().catch((error) => {
			notifications.error(error instanceof Error ? error.message : m.terminal_create_failed());
		});
	}

	function toggleMobileSidebar() {
		appShell.setSidebarOpen(!appShell.sidebarOpen);
	}

	function closeMobileSidebar() {
		appShell.setSidebarOpen(false);
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
		onShowScheduledPrompts={() => appShell.openScheduledPrompts()}
		onShowSettings={() => appShell.openSettings()}
		{newWindowActions}
	/>
{/snippet}

{#snippet desktopChatList(dock: ChatListDock)}
	{@const dividerEdge = chatListDividerEdge(dock)}
	<div
		data-workspace-chat-list
		onfocusin={() => workspace.noteChatListFocus()}
		onpointerdown={() => workspace.noteChatListFocus()}
		class="relative h-full shrink-0 overflow-hidden border-border"
		class:order-first={dock === 'left'}
		class:order-last={dock === 'right'}
		class:border-s={dividerEdge === 'start' && !hideLeftSidebar}
		class:border-e={dividerEdge === 'end' && !hideLeftSidebar}
		class:pointer-events-none={hideLeftSidebar}
		style:width={hideLeftSidebar ? '0px' : `${localSettings.sidebarWidth}px`}
		aria-hidden={hideLeftSidebar}
		inert={hideLeftSidebar}
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
{/snippet}

<div
	class="flex w-screen overflow-hidden bg-background text-foreground"
	class:mobile-shell={isMobile}
	class:h-dvh={!isMobile}
	class:flex-col={isMobile}
>
	{#if isMobile && appShell.sidebarOpen}
		<div class="fixed inset-0 z-40">
			<button
				class="absolute inset-0 transient-backdrop"
				onclick={closeMobileSidebar}
				aria-label={m.layout_close_sidebar()}
			></button>
			<div
				data-workspace-chat-list
				role="navigation"
				aria-label={m.layout_chat_list()}
				class="absolute inset-y-0 left-0 z-50 w-[85%] max-w-sm bg-card shadow-2xl"
				onfocusin={() => workspace.noteChatListFocus()}
				onpointerdown={() => workspace.noteChatListFocus()}
			>
				{@render sidebarContent(true, handleMobileChatSelect)}
			</div>
		</div>
	{/if}

	<div class="flex min-h-0 min-w-0 flex-1 overflow-hidden">
		{#if !isMobile}
			{@render desktopChatList(localSettings.chatListDock)}
		{/if}
		<div class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
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
	chatTitle={chatActionDialogs.shareChatDialog?.chatTitle ?? ''}
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

{#if appShell.showSnippets}
	{#await lazySnippets() then { default: SnippetsDialog }}
		<SnippetsDialog />
	{/await}
{/if}
