<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import Sidebar from '../sidebar/Sidebar.svelte';
	import ResizeHandle from './ResizeHandle.svelte';
	import BottomTabBar from './BottomTabBar.svelte';
	import WorkspaceView from './WorkspaceView.svelte';
	import type { AppTab } from '$lib/types/app';

	const lazySettings = () => import('../settings/Settings.svelte');
	import { getNavigation, getChatRuntime, getChatSessions, getAppShell, getWs, getPreferences } from '$lib/context';
	import * as m from '$lib/paraglide/messages.js';
	import { ChatRunningQueryRequest } from '$shared/ws-requests';
	import { AppShellController } from './app-shell-controller.svelte';
	import NewChatDialog from '../chat/NewChatDialog.svelte';
	import FileViewerHost from '../files/FileViewerHost.svelte';

	const navigation = getNavigation();
	const chatRuntime = getChatRuntime();
	const sessions = getChatSessions();
	const appShell = getAppShell();
	const ws = getWs();
	const preferences = getPreferences();
	const shellController = new AppShellController({
		upsertFromServer: (s) => sessions.upsertFromServer(s),
		setLoadingChats: (v) => { chatRuntime.isLoadingChats = v; },
	});

	let isMobile = $state(false);
	let isWorkspaceFullscreen = $state(false);
	const isAutoFullscreenOnGitTab = $derived(
		!isMobile &&
		navigation.activeTab === 'git' &&
		preferences.alwaysFullscreenOnGitPanel
	);
	const effectiveWorkspaceFullscreen = $derived(isWorkspaceFullscreen || isAutoFullscreenOnGitTab);

	// Syncs URL params to selected chat ID. The session store is the
	// single source of truth; this effect keeps it in sync with the URL.
	$effect(() => {
		const chatId = page.params.id as string | undefined;
		if (!chatId) {
			if (page.url.pathname === '/') {
				sessions.setSelectedChatId(null);
			}
			return;
		}
		sessions.setSelectedChatId(chatId);
	});

	$effect(() => {
		if (typeof window === 'undefined') return;
		const mql = window.matchMedia('(max-width: 768px)');
		isMobile = mql.matches;

		function onChange(e: MediaQueryListEvent) {
			isMobile = e.matches;
			if (!e.matches) appShell.setSidebarOpen(false);
		}

		mql.addEventListener('change', onChange);
		return () => mql.removeEventListener('change', onChange);
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
		ws.sendMessage(new ChatRunningQueryRequest());
	}

	appShell.registerRefreshChats(fetchChats);
	appShell.registerQuietRefreshChats(quietRefresh);

	// Fetches chat list + processing state whenever the WS connects
	// (initial page load and reconnect).
	$effect(() => {
		if (!ws.isConnected) return;
		fetchChatsAndReconcile();
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

	function handleChatDelete(chatId: string) {
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

	onMount(() => appShell.onNewChatRequested(() => handleNewChat()));
</script>

	{#if !isMobile}
		<div class="flex h-dvh w-screen overflow-hidden bg-background text-foreground">
			{#if !effectiveWorkspaceFullscreen}
				<div
					class="relative flex-shrink-0 h-full border-r border-border"
					style:width="{appShell.sidebarWidth}px"
				>
					<Sidebar
						chats={sessions.orderedChats}
						selectedChatId={sessions.selectedChatId}
						isLoading={chatRuntime.isLoadingChats}
						onChatSelect={handleChatSelect}
						onNewChat={handleNewChat}
						onChatDelete={handleChatDelete}
						onQuietRefresh={quietRefresh}
						onChatRenamed={handleChatRenamed}
						onShowSettings={() => appShell.openSettings()}
					/>
					<ResizeHandle
						width={appShell.sidebarWidth}
						onResize={(w) => appShell.setSidebarWidth(w)}
					/>
				</div>
			{/if}

			<div class="flex-1 min-w-0 h-full overflow-hidden">
				<WorkspaceView
					activeTab={navigation.activeTab}
					onTabChange={handleTabChange}
					isDesktopFullscreen={effectiveWorkspaceFullscreen}
					onToggleDesktopFullscreen={() => isWorkspaceFullscreen = !isWorkspaceFullscreen}
				/>
			</div>
		</div>

{:else}
	<div class="flex flex-col h-dvh w-screen overflow-hidden bg-background text-foreground">
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
							onChatSelect={(chatId) => {
							handleChatSelect(chatId);
							closeMobileSidebar();
						}}
							onNewChat={handleNewChat}
							onChatDelete={handleChatDelete}
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

		<BottomTabBar
			activeTab={navigation.activeTab}
			onTabChange={handleTabChange}
			onMenuClick={toggleMobileSidebar}
		/>
	</div>
{/if}

<NewChatDialog />
<FileViewerHost />

{#if appShell.showSettings}
	{#await lazySettings() then { default: Settings }}
		<Settings />
	{/await}
{/if}
