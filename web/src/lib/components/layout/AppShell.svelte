<script lang="ts">
	import { ArchiveUndoController } from '$lib/chat/actions/archive-undo-controller.js';
	import { onDestroy, onMount, tick, untrack, type ComponentProps } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import { Dialog as DialogPrimitive } from 'bits-ui';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { gotoChat } from '$lib/chat/actions/chat-navigation.js';
	import Sidebar from '../sidebar/Sidebar.svelte';
	import ResizeHandle from './ResizeHandle.svelte';
	import BottomTabBar from '$lib/components/workspace/BottomTabBar.svelte';
	import WorkspaceRoot from '$lib/components/workspace/WorkspaceRoot.svelte';
	import NotificationHost from '$lib/components/shared/NotificationHost.svelte';
	import type { MobileWorkspaceTabId } from '$lib/components/workspace/mobile-workspace-tabs';
	import type { ChatSessionRecord } from '$lib/chat/sessions/chat-session-types';
	import type { NewChatDialogSeed } from '$lib/chat/new-chat/new-chat-seed';
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
		getWorkbenchCommands,
		getNavigation,
		getChatSessions,
		getAppShell,
		getWs,
		getLocalSettings,
		getNotifications,
		getSidebarSearch,
		getWorkspaceCoordinator,
		setChatDrafts,
		setNewChatPromptDrafts,
	} from '$lib/context';
	import * as m from '$lib/paraglide/messages.js';
	import { WsConnectionNotificationPresenter } from '$lib/ws/connection-notifications';
	import { resolveAdjacentChatId } from './app-shell-chat-navigation';
	import { bindAppShellRoute } from './app-shell-route-sync.svelte.js';
	import NewChatDialog from '../chat/new-chat/NewChatDialog.svelte';
	import FileDirtyUnloadGuard from '../files/FileDirtyUnloadGuard.svelte';
	import CombinationRefreshDialog from '../settings/CombinationRefreshDialog.svelte';
	import WorkspaceCloseGuard from '$lib/components/workspace/WorkspaceCloseGuard.svelte';
	import { bindMobileViewport } from './mobile-viewport-binding';
	import { ChatActionController } from '$lib/components/chat/chat-action-controller.svelte';
	import { ChatActionDialogsState } from '$lib/components/chat/chat-action-dialogs-state.svelte';
	import AppShellChatDialogs from './AppShellChatDialogs.svelte';
	import SidebarSearchDialogs from '$lib/components/sidebar/search/SidebarSearchDialogs.svelte';
	import type {
		SearchResultNavigationPort,
		SearchResultSelection,
	} from '$lib/sidebar/search/search-result-navigation-controller.js';
	import { createAppShellSidebarOrder } from './app-shell-sidebar-order';
	import { createAppShellMobileDrawer } from './app-shell-mobile-drawer.js';
	import SidebarDisplayDialog from '../sidebar/SidebarDisplayDialog.svelte';
	import type { WorkspaceWindowEdge } from '$lib/workspace/surface-types.js';
	import type { WorkspaceSplitAdmissions } from '$lib/workspace/window-geometry-policy.js';
	import { ChatDraftStore } from '$lib/chat/composer/chat-draft-store.svelte.js';
	import { NewChatPromptDraftStore } from '$lib/chat/new-chat/new-chat-prompt-draft.js';
	import { AppShellChatNavigationController } from './app-shell-chat-navigation-controller.svelte.js';
	import type { DrawerComposerSelection } from '$lib/stores/app-shell.svelte.js';
	import { ChatListAutohideState } from './chat-list-autohide-state.svelte.js';

	const commandRegistry = getWorkbenchCommands();
	const navigation = getNavigation();
	const sessions = getChatSessions();
	const appShell = getAppShell();
	const ws = getWs();
	const localSettings = getLocalSettings();
	const notifications = getNotifications();
	const sidebarSearch = getSidebarSearch();
	const workspace = getWorkspaceCoordinator();
	const hoverCapability = new MediaQuery(HOVER_CAPABLE_MEDIA_QUERY);
	const chatDrafts = new ChatDraftStore();
	setChatDrafts(chatDrafts);
	setNewChatPromptDrafts(new NewChatPromptDraftStore());
	const wsConnectionNotifications = new WsConnectionNotificationPresenter({
		notifications,
	});
	const chatActionDialogs = new ChatActionDialogsState();
	let sidebarDisplayOpen = $state(false);
	let sidebarDisplayReturnFocus = $state<(() => void) | undefined>();
	const sidebarOrder = createAppShellSidebarOrder();
	const displayedSidebarChatIds = $derived(sidebarOrder.projection.rowModel.visibleChatIds);
	const mobileDrawer = createAppShellMobileDrawer(handleChatSelect);
	const archiveUndo = new ArchiveUndoController(sessions, notifications);
	$effect(() => archiveUndo.reconcile());
	const chatActionController = new ChatActionController({
		get chats() {
			return sessions.orderedChats;
		},
		get displayedChatIds() {
			return displayedSidebarChatIds;
		},
		get selectedChatId() {
			return sessions.selectedChatId;
		},
		projectPathRevision: (chatId) => sessions.projectPathRevision(chatId),
		pendingSettings: (id) => sessions.settingsMutations.pendingFor(id),
		onQuietRefresh: quietRefresh,
		isArchiveMutationPending: (chatId) => sessions.isArchiveMutationPending(chatId),
		startArchivingChats: (chatIds) => archiveUndo.startArchivingChats(chatIds),
		startUnarchivingChats: (chatIds) => archiveUndo.startUnarchivingChats(chatIds),
		onSelectChat: handleChatSelect,
		onOpenForkedChat: handleOpenForkedChat,
		onNewChat: handleNewChat,
		onDeleteChat: handleChatDelete,
		onRenameChat: handleChatRenamed,
		onProjectPathUpdated: handleChatProjectPathUpdated,
		onUpsertServerChat: (entry) => sessions.upsertServerChat(entry),
		replaceChatTags: (input) => sessions.replaceChatTags(input),
		onReloadChat: handleReloadChat,
		notifyError(message) {
			notifications.error(message);
		},
		showProgress(key, message) {
			notifications.info(message, { key, timeoutMs: null });
			return () => notifications.dismissKey(key);
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
	let mobileKeyboardVisible = $state(false);
	let reloadSelectedChatFn: ((chatId: string) => Promise<void>) | null = null;
	let sidebarPreviewWidth = $state<number | null>(null);
	const sidebarWidth = $derived(sidebarPreviewWidth ?? localSettings.sidebarWidth);
	let searchResultNavigation: SearchResultNavigationPort | null = null;
	let searchSelectionVersion = 0;
	const workspaceFullscreen = $derived(
		!isMobile && workspace.layout.snapshot.fullscreenWindowId !== null,
	);
	const newWindowEdges = $derived<WorkspaceSplitAdmissions>(
		workspace.resolveSplitAdmissions(workspace.currentWindowId),
	);
	const hideChatList = $derived(
		workspaceFullscreen &&
			(localSettings.fullscreenCoversSidebar ||
				localSettings.chatListAutohide ||
				workspace.windowCount === 1),
	);
	const chatListAutohideActive = $derived(
		!isMobile && !hideChatList && localSettings.chatListAutohide && hoverCapability.current,
	);
	const chatListAutohide = new ChatListAutohideState({
		get active() {
			return chatListAutohideActive;
		},
	});
	const desktopChatListHidden = $derived(hideChatList || chatListAutohide.collapsed);
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
					mobileActiveDescriptor.kind === 'chat-map' ||
					mobileActiveDescriptor.kind === 'chat-canvas' ||
					mobileActiveDescriptor.kind === 'pull-requests' ||
					mobileActiveDescriptor.kind === 'chat-board' ||
					mobileActiveDescriptor.kind === 'tickets' ||
					mobileActiveDescriptor.kind === 'usage' ||
					mobileActiveDescriptor.kind === 'git-history' ||
					mobileActiveDescriptor.kind === 'git-compare')),
	);
	let notificationDesktopInlineStartPx = $derived(
		!isMobile && !hideChatList && !chatListAutohideActive && localSettings.chatListDock === 'left'
			? sidebarWidth + 16
			: 16,
	);
	const sidebarMounted = $derived(!isMobile || appShell.sidebarOpen);
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
		get focusedChatId() {
			return workspace.focusedChatId;
		},
		hasChat: (chatId) => sessions.hasChat(chatId),
		showChatInCurrentWindow: (chatId) => workspace.showChatInCurrentWindow(chatId),
		setSelectedChatId: (chatId) => sessions.setSelectedChatId(chatId),
		navigateToChat: gotoChat,
		navigateToBareRoute: () => goto(resolve('/')),
		requestComposerFocus: (selection) => appShell.requestComposerFocus(selection),
		requestSidebarRecenter: () => appShell.requestSidebarRecenterToSelected(),
		reportOpenError: reportWorkspaceOpenError,
		reportDeleteError: (error) => {
			notifications.error(
				error instanceof Error ? error.message : m.notifications_delete_chat_failed(),
			);
		},
	});

	bindAppShellRoute(chatNavigation);

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

	// A mobile drawer remount must reopen on the chat list, not on the
	// search dialog cluster that outlived the previous drawer instance.
	$effect(() => {
		if (isMobile && !appShell.sidebarOpen) sidebarSearch.resetDialogs();
	});

	$effect(() => {
		if (!isMobile && hoverCapability.current) return;
		const unbindViewport = bindMobileViewport((metrics) => {
			mobileKeyboardVisible = metrics.keyboardVisible;
			appShell.keyboardHeight = metrics.keyboardHeight;
		});
		if (!unbindViewport) return;
		return () => {
			unbindViewport();
			mobileKeyboardVisible = false;
			appShell.keyboardHeight = 0;
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

	function handleChatSelect(chatId: string, drawerSelection?: DrawerComposerSelection): void {
		cancelSearchResultNavigation();
		void chatNavigation.showChatInCurrentWindow(chatId, { navigate: true, drawerSelection });
	}

	function cancelSearchResultNavigation(): void {
		searchSelectionVersion++;
		searchResultNavigation?.cancel();
	}

	function handleRegisterSearchNavigation(port: SearchResultNavigationPort): () => void {
		searchResultNavigation = port;
		return () => {
			port.cancel();
			if (searchResultNavigation === port) {
				searchSelectionVersion++;
				searchResultNavigation = null;
			}
		};
	}

	async function handleSearchResultSelect(selection: SearchResultSelection): Promise<void> {
		cancelSearchResultNavigation();
		const version = searchSelectionVersion;
		const port = searchResultNavigation;
		if (isMobile) mobileDrawer.close();
		// Completes dialog and drawer focus restoration before navigation owns focus.
		await tick();
		if (version !== searchSelectionVersion || port !== searchResultNavigation) return;
		if (!port) {
			notifications.error(m.sidebar_search_target_failed());
			return;
		}
		await port.open(selection);
	}

	function reportWorkspaceOpenError(error: unknown): void {
		notifications.error(error instanceof Error ? error.message : m.workspace_open_failed());
	}

	function handleOpenChatInNewWindow(chatId: string, edge?: WorkspaceWindowEdge): void {
		void workspace.openChatInNewWindow(chatId, undefined, edge).catch(reportWorkspaceOpenError);
	}

	function handleOpenForkedChat(chatId: string, sourceChatId: string): void {
		void workspace
			.openForkedChat(chatId, sourceChatId, localSettings.forkOpenPlacement)
			.catch(reportWorkspaceOpenError);
	}

	function handleNewChat() {
		openNewChatDialog();
	}

	function openNewChatDialog(seed?: NewChatDialogSeed): void {
		if (isMobile) {
			appShell.setSidebarOpen(false);
		}
		appShell.openNewChatDialog(seed);
	}

	// Navigates to the chat above or below the currently selected one.
	// No-op when no chat is selected or at the list boundary.
	function navigateChatAdjacent(offset: -1 | 1) {
		const targetId = resolveAdjacentChatId({
			selectedChatId: sessions.selectedChatId,
			displayedChatIds: sidebarMounted ? displayedSidebarChatIds : null,
			displayedRows: sidebarMounted ? sidebarOrder.projection.rowModel.rows : undefined,
			fallbackOrder: sessions.order,
			offset,
		});
		if (!targetId) return;
		void chatNavigation.showChatInCurrentWindow(targetId, { navigate: true });
	}

	// Updates navigation immediately; only a confirmed deletion retires the saved branch choice.
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
			throw new Error(m.sidebar_chats_reload_view_unavailable());
		}
		await reloadSelectedChatFn(chatId);
		await quietRefresh();
	}

	async function handleMobileTabChange(tab: MobileWorkspaceTabId): Promise<void> {
		try {
			if (tab === 'chat') {
				await workspace.focusChat();
			} else if (tab === 'terminal') {
				await workspace.focusMostRecentTerminalOrCreate();
			} else {
				await workspace.focusMobileSingleton(tab);
			}
		} catch (error) {
			const fallback = tab === 'terminal' ? m.terminal_create_failed() : m.workspace_open_failed();
			notifications.error(error instanceof Error ? error.message : fallback);
		}
	}

	async function handleShowUsage(): Promise<void> {
		if (isMobile) mobileDrawer.close();
		// Completes drawer focus restoration before the surface owns focus.
		await tick();
		try {
			await workspace.openSingleton('usage');
		} catch (error) {
			notifications.error(error instanceof Error ? error.message : m.workspace_open_failed());
		}
	}

	function handleChatProjectPathUpdated(chatId: string, patch: { projectPath: string }): void {
		sessions.patchChat(chatId, { projectPath: patch.projectPath });
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

	const workspaceChatActions = {
		requestDelete: requestDeleteChat,
		requestRename: requestRenameChat,
		requestDetails: requestDetailsChat,
		requestShare: requestShareChat,
		requestProjectPath: requestProjectPathChat,
		requestParent: (chat: ChatSessionRecord) =>
			chatActionDialogs.requestParent(chat, m.sidebar_chats_new_chat()),
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

	onMount(() =>
		commandRegistry.registerChatNavigation({
			get recentChats() {
				return sessions.recentChats;
			},
			hasChat: (id) => sessions.hasChat(id),
			open: (id) => chatNavigation.showChatInCurrentWindow(id, { navigate: true }),
		}),
	);
	onMount(() => chatDrafts.mountPersistenceLifecycle());
	onDestroy(() => {
		sidebarOrder.destroy();
		archiveUndo.destroy();
		chatNavigation.destroy();
		chatDrafts.destroy();
	});

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

	function collapseAutohiddenChatListOnWorkspaceInteraction(node: HTMLElement): () => void {
		function handlePointerEnter(): void {
			chatListAutohide.collapseUnlessEngaged(desktopChatListPanelElement);
		}

		function handlePointerDown(): void {
			if (chatListAutohide.active) chatListAutohide.collapse();
		}

		node.addEventListener('pointerenter', handlePointerEnter);
		node.addEventListener('pointerdown', handlePointerDown);
		return () => {
			node.removeEventListener('pointerenter', handlePointerEnter);
			node.removeEventListener('pointerdown', handlePointerDown);
		};
	}

	const sidebarActions = {
		onNewChat: handleNewChat,
		onNewProjectChat: (project) => openNewChatDialog({ project }),
		onLocallyDeleteChat: locallyDeleteChat,
		onQuietRefresh: quietRefresh,
		onRequestDeleteChat: requestDeleteChat,
		onRequestRenameChat: requestRenameChat,
		onTogglePinned: (id) => chatActionController.togglePinned(id),
		onToggleArchive: (id) => chatActionController.toggleArchive(id),
		isArchiveMutationPending: (id) => sessions.isArchiveMutationPending(id),
		startArchivingChats: (chatIds) => archiveUndo.startArchivingChats(chatIds),
		startUnarchivingChats: (chatIds) => archiveUndo.startUnarchivingChats(chatIds),
		onShowDetails: requestDetailsChat,
		onForkChat: (id) => chatActionController.forkChat(id),
		onShareChat: requestShareChat,
		onManageTags: requestTagsChat,
		onTileWorkingChats: (chatIds) => workspace.tileChats(chatIds),
		onChatListAutohideChange: handleChatListAutohideChange,
		onShowScheduledPrompts: () => appShell.openScheduledPrompts(),
		onShowPreambles: () => appShell.openPreambles(),
		onShowSnippets: () => appShell.openSnippets(),
		onShowUsage: () => void handleShowUsage(),
		onShowSettings: () => appShell.openSettings(),
	} satisfies Partial<ComponentProps<typeof Sidebar>>;
</script>

{#snippet sidebarContent(isMobile: boolean, onChatSelect: (chatId: string) => void)}
	<Sidebar
		actionsHidden={!isMobile && desktopChatListHidden}
		projection={sidebarOrder.projection}
		reorder={sidebarOrder}
		onShowDisplay={(returnFocus) => {
			sidebarDisplayReturnFocus = returnFocus;
			sidebarDisplayOpen = true;
		}}
		chats={sessions.orderedChats}
		selectedChatId={sessions.selectedChatId}
		isLoading={sessions.isLoadingChats}
		rosterReady={sessions.chatListStatus === 'ready'}
		{isMobile}
		{onChatSelect}
		{...sidebarActions}
		onOpenChatInNewWindow={isMobile ? undefined : handleOpenChatInNewWindow}
		chatListAutohideAvailable={hoverCapability.current}
		{newWindowEdges}
	/>
{/snippet}
{#if sidebarDisplayOpen}
	<SidebarDisplayDialog
		returnFocus={sidebarDisplayReturnFocus}
		onClose={() => (sidebarDisplayOpen = false)}
	/>
{/if}

{#snippet desktopChatList(dock: ChatListDock)}
	{@const dividerEdge = chatListDividerEdge(dock)}
	<div
		data-workspace-chat-list
		onfocusin={handleDesktopChatListFocus}
		onpointerdown={() => workspace.noteChatListFocus()}
		onpointerenter={() => chatListAutohide.reveal()}
		onkeydown={handleDesktopChatListKeydown}
		class={[
			'relative z-50 h-full shrink-0',
			chatListAutohide.active && !hideChatList ? 'overflow-visible' : 'overflow-hidden',
		]}
		class:order-first={dock === 'left'}
		class:order-last={dock === 'right'}
		class:pointer-events-none={hideChatList}
		style:width={hideChatList || chatListAutohide.active ? '0px' : `${sidebarWidth}px`}
		aria-hidden={hideChatList}
		inert={hideChatList}
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
			data-divider-edge={hideChatList ? undefined : dividerEdge}
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
			class:border-s={dividerEdge === 'start' && !hideChatList}
			class:border-e={dividerEdge === 'end' && !hideChatList}
			style:width={chatListAutohide.active ? `${sidebarWidth}px` : undefined}
			tabindex="-1"
			aria-hidden={desktopChatListHidden}
			inert={desktopChatListHidden}
		>
			{@render sidebarContent(false, handleChatSelect)}
			{#if !hideChatList}
				<ResizeHandle
					edge={dividerEdge}
					width={sidebarWidth}
					onPreview={(width) => (sidebarPreviewWidth = width)}
					onCommit={(width) => localSettings.set('sidebarWidth', width)}
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
				if (!open) mobileDrawer.close();
			}}
		>
			<DialogPrimitive.Overlay
				class="fixed inset-0 z-40 transient-backdrop"
				onclick={mobileDrawer.close}
			/>
			<DialogPrimitive.Content
				data-workspace-chat-list
				aria-label={m.layout_chat_list()}
				class="fixed inset-y-0 left-0 z-50 h-full w-[85%] max-w-sm bg-card shadow-2xl"
				onOpenAutoFocus={mobileDrawer.captureReturnTarget}
				onCloseAutoFocus={mobileDrawer.onCloseAutoFocus}
				onfocusin={() => workspace.noteChatListFocus()}
				onpointerdown={mobileDrawer.onPointerDown}
				{@attach appShell.sidebarOpen ? mobileDrawer.layer : undefined}
			>
				{@render sidebarContent(true, mobileDrawer.selectChat)}
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
			{@attach collapseAutohiddenChatListOnWorkspaceInteraction}
		>
			<div class="min-h-0 flex-1 overflow-hidden">
				<WorkspaceRoot
					{isMobile}
					onRegisterReload={handleRegisterReload}
					onRegisterSearchNavigation={handleRegisterSearchNavigation}
					chatActions={workspaceChatActions}
				/>
			</div>
			{#if isMobile && !mobileKeyboardVisible && !mobileTransientSurface}
				<BottomTabBar
					activeItem={mobileActiveTab}
					onTabChange={handleMobileTabChange}
					onMenuClick={mobileDrawer.toggle}
				/>
			{/if}
		</div>
	</div>
</div>

<SidebarSearchDialogs chats={sessions.orderedChats} onSelectResult={handleSearchResultSelect} />

<AppShellChatDialogs {chatActionDialogs} {chatActionController} {isMobile} />

<NewChatDialog />
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

<CombinationRefreshDialog deferred={appShell.showOnboardingWizard} />
