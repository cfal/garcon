<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import Sidebar from '../sidebar/Sidebar.svelte';
	import ResizeHandle from './ResizeHandle.svelte';
	import BottomTabBar from './BottomTabBar.svelte';
	import WorkspaceView from './WorkspaceView.svelte';
	import NotificationHost from '$lib/components/shared/NotificationHost.svelte';
	import type { AppTab } from '$lib/types/app';

	const lazySettings = () => import('../settings/Settings.svelte');
	import {
		getNavigation,
		getChatRuntime,
		getChatSessions,
		getAppShell,
		getWs,
		getLocalSettings,
		getNotifications,
	} from '$lib/context';
	import * as m from '$lib/paraglide/messages.js';
	import { getRunningChats } from '$lib/api/chats.js';
	import { AppShellController } from './app-shell-controller.svelte';
	import { selectedChatIdFromRoute } from './app-shell-route';
	import NewChatDialog from '../chat/NewChatDialog.svelte';
	import FileViewerHost from '../files/FileViewerHost.svelte';
	import { computeMobileViewportMetrics } from './mobile-viewport';

	const navigation = getNavigation();
	const chatRuntime = getChatRuntime();
	const sessions = getChatSessions();
	const appShell = getAppShell();
	const ws = getWs();
	const localSettings = getLocalSettings();
	const notifications = getNotifications();
	const shellController = new AppShellController({
		upsertFromServer: (s) => sessions.upsertFromServer(s),
		setLoadingChats: (v) => {
			chatRuntime.isLoadingChats = v;
		},
	});

	let isMobile = $state(false);
	let isWorkspaceFullscreen = $state(false);
	let mobileAppHeight = $state<number | null>(null);
	let mobileViewportBaselineHeight = $state<number | null>(null);
	let mobileKeyboardVisible = $state(false);
	const isAutoFullscreenOnGitTab = $derived(
		!isMobile && navigation.activeTab === 'git' && localSettings.alwaysFullscreenOnGitPanel,
	);
	const effectiveWorkspaceFullscreen = $derived(isWorkspaceFullscreen || isAutoFullscreenOnGitTab);

	// Syncs URL params to selected chat ID. The session store is the
	// single source of truth; this effect keeps it in sync with the URL.
	$effect(() => {
		const chatId = page.params.id as string | undefined;
		const selectedChatId = selectedChatIdFromRoute(page.url.pathname, chatId);
		if (selectedChatId !== undefined) sessions.setSelectedChatId(selectedChatId);
	});

	$effect(() => {
		if (typeof window === 'undefined') return;
		const mql = window.matchMedia('(max-width: 768px)');
		isMobile = mql.matches;
		appShell.isMobile = mql.matches;

		function onChange(e: MediaQueryListEvent) {
			isMobile = e.matches;
			appShell.isMobile = e.matches;
			if (!e.matches) appShell.setSidebarOpen(false);
		}

		mql.addEventListener('change', onChange);
		return () => mql.removeEventListener('change', onChange);
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

	function fetchChats() {
		return shellController.fetchChats();
	}

	function quietRefresh() {
		return shellController.quietRefresh();
	}

	/** Fetches the chat list, then requests the processing snapshot.
	 *  Ensures reconcileProcessing runs against a populated byId map. */
	async function fetchChatsAndReconcile() {
		await quietRefresh();
		const running = await getRunningChats();
		const activeChatIds = new Set<string>();
		for (const sessionsForProvider of Object.values(running.sessions)) {
			for (const session of sessionsForProvider) {
				if (session.id) activeChatIds.add(session.id);
			}
		}
		sessions.reconcileProcessing(activeChatIds);
	}

	appShell.registerRefreshChats(fetchChats);
	appShell.registerQuietRefreshChats(quietRefresh);

	// Fetches chat list + processing state whenever the WS connects
	// (initial page load and reconnect).
	$effect(() => {
		if (!ws.isConnected) return;
		fetchChatsAndReconcile().catch((error) => {
			console.warn(
				'app-shell: failed to reconcile running chats:',
				error instanceof Error ? error.message : String(error),
			);
		});
	});

	onMount(() => {
		// Kick off fetchChats early so the sidebar populates even
		// before the WS connection opens.
		fetchChats();
	});

	function handleChatSelect(chatId: string) {
		sessions.setSelectedChatId(chatId);
		goto(`/chat/${chatId}`);
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
		const chatId = sessions.selectedChatId;
		if (!chatId) return;
		const order = sessions.order;
		const idx = order.indexOf(chatId);
		if (idx < 0) return;
		const targetId = order[idx + offset];
		if (!targetId) return;
		sessions.setSelectedChatId(targetId);
		goto(`/chat/${targetId}`);
	}

	// Applies the same store mutations the ChatSessionDeletedWsMessage handler
	// would apply once the server broadcast arrives. Running it eagerly lets
	// the sidebar and URL update without waiting for the HTTP round-trip.
	function locallyDeleteChat(chatId: string) {
		if (!sessions.hasChat(chatId)) return;
		if (sessions.selectedChatId === chatId) {
			const idx = sessions.order.indexOf(chatId);
			const neighborId = sessions.order[idx - 1] ?? sessions.order[idx + 1] ?? null;
			if (neighborId) {
				sessions.setSelectedChatId(neighborId);
				goto(`/chat/${neighborId}`);
			} else {
				sessions.setSelectedChatId(null);
				goto('/');
			}
		}
		sessions.removeChat(chatId);
	}

	function handleChatDelete(chatId: string) {
		locallyDeleteChat(chatId);
		return shellController.deleteChat(chatId);
	}

	function handleChatRenamed(chatId: string, newTitle: string) {
		return shellController.renameChat(chatId, newTitle);
	}

	function handleTabChange(tab: AppTab) {
		navigation.setActiveTab(tab);
	}

	function toggleMobileSidebar() {
		appShell.setSidebarOpen(!appShell.sidebarOpen);
	}

	function closeMobileSidebar() {
		appShell.setSidebarOpen(false);
	}

	onMount(() => {
		appShell.onNewChatRequested(() => handleNewChat());
		appShell.onNavigateChatAboveRequested(() => navigateChatAdjacent(-1));
		appShell.onNavigateChatBelowRequested(() => navigateChatAdjacent(1));
	});
</script>

{#if !isMobile}
	<div class="flex h-dvh w-screen overflow-hidden bg-background text-foreground">
		<div
			class={`relative h-full overflow-hidden ${effectiveWorkspaceFullscreen ? 'w-0 border-r-0 pointer-events-none' : 'flex-shrink-0 border-r border-border'}`}
			style:width={effectiveWorkspaceFullscreen ? '0px' : `${localSettings.sidebarWidth}px`}
			aria-hidden={effectiveWorkspaceFullscreen}
			inert={effectiveWorkspaceFullscreen}
		>
			<Sidebar
				chats={sessions.orderedChats}
				selectedChatId={sessions.selectedChatId}
				isLoading={chatRuntime.isLoadingChats}
				isMobile={false}
				onChatSelect={handleChatSelect}
				onNewChat={handleNewChat}
				onChatDelete={handleChatDelete}
				onLocallyDeleteChat={locallyDeleteChat}
				onQuietRefresh={quietRefresh}
				onChatRenamed={handleChatRenamed}
				onShowSettings={() => appShell.openSettings()}
			/>
			{#if !effectiveWorkspaceFullscreen}
				<ResizeHandle
					width={localSettings.sidebarWidth}
					onResize={(w) => localSettings.set('sidebarWidth', w)}
				/>
			{/if}
		</div>

		<div class="flex-1 min-w-0 h-full overflow-hidden">
			<WorkspaceView
				activeTab={navigation.activeTab}
				onTabChange={handleTabChange}
				isDesktopFullscreen={effectiveWorkspaceFullscreen}
				onToggleDesktopFullscreen={() => (isWorkspaceFullscreen = !isWorkspaceFullscreen)}
			/>
		</div>
	</div>
{:else}
	<div class="mobile-shell flex flex-col w-screen overflow-hidden bg-background text-foreground">
		{#if appShell.sidebarOpen}
			<div class="fixed inset-0 z-40">
				<button
					class="absolute inset-0 bg-black/50 backdrop-blur-sm"
					onclick={closeMobileSidebar}
					aria-label={m.layout_close_sidebar()}
				></button>
				<div class="absolute inset-y-0 left-0 w-[85%] max-w-sm bg-card shadow-2xl z-50">
					<Sidebar
						chats={sessions.orderedChats}
						selectedChatId={sessions.selectedChatId}
						isLoading={chatRuntime.isLoadingChats}
						isMobile={true}
						onChatSelect={(chatId) => {
							handleChatSelect(chatId);
							closeMobileSidebar();
						}}
						onNewChat={handleNewChat}
						onChatDelete={handleChatDelete}
						onLocallyDeleteChat={locallyDeleteChat}
						onQuietRefresh={quietRefresh}
						onChatRenamed={handleChatRenamed}
						onShowSettings={() => appShell.openSettings()}
					/>
				</div>
			</div>
		{/if}

		<div class="flex-1 min-h-0 overflow-hidden">
			<WorkspaceView
				activeTab={navigation.activeTab}
				onTabChange={handleTabChange}
				onMenuClick={toggleMobileSidebar}
			/>
		</div>

		{#if !mobileKeyboardVisible}
			<BottomTabBar
				activeTab={navigation.activeTab}
				onTabChange={handleTabChange}
				onMenuClick={toggleMobileSidebar}
			/>
		{/if}
	</div>
{/if}

<NewChatDialog />
<FileViewerHost />
<NotificationHost {notifications} />

{#if appShell.showSettings}
	{#await lazySettings() then { default: Settings }}
		<Settings />
	{/await}
{/if}
