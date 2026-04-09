<script lang="ts">
	import type { AppTab } from '$lib/types/app';
	import { getChatSessions, getLocalSettings, getSplitLayout } from '$lib/context';
	import Menu from '@lucide/svelte/icons/menu';
	import Maximize2 from '@lucide/svelte/icons/maximize-2';
	import Minimize2 from '@lucide/svelte/icons/minimize-2';
	import Share2 from '@lucide/svelte/icons/share-2';
	import PanelLeft from '@lucide/svelte/icons/panel-left';
	import Grid2x2 from '@lucide/svelte/icons/grid-2x2';
	import * as m from '$lib/paraglide/messages.js';
	import ChatEmptyState from '$lib/components/chat/ChatEmptyState.svelte';
	import ConversationWorkspace from '$lib/components/chat/ConversationWorkspace.svelte';
	import ShareChatDialog from '$lib/components/chat/ShareChatDialog.svelte';
	import SplitContainer from '$lib/components/split/SplitContainer.svelte';
	import { cn } from '$lib/utils/cn';
	import { CHAT_TOOLBAR_TABS } from './chat-toolbar-tabs';

	// Lazy-loaded tab panels to keep the main chunk lean. Each panel
	// pulls in heavy dependencies (CodeMirror, xterm, git logic).
	const lazyFilesPanel = () => import('$lib/components/files/FilesPanel.svelte');
	const lazyStandaloneShell = () => import('$lib/components/shell/StandaloneShell.svelte');
	const lazyGitPanel = () => import('$lib/components/git/GitPanel.svelte');

	interface MainContentProps {
		activeTab: AppTab;
		onTabChange: (tab: AppTab) => void;
		onMenuClick?: () => void;
		isDesktopFullscreen?: boolean;
		onToggleDesktopFullscreen?: () => void;
	}

	let {
		activeTab,
		onTabChange,
		onMenuClick,
		isDesktopFullscreen = false,
		onToggleDesktopFullscreen
	}: MainContentProps = $props();

	const sessions = getChatSessions();
	const localSettings = getLocalSettings();
	const splitLayout = getSplitLayout();

	// Derives selected chat from the canonical session store.
	const selectedChat = $derived(sessions.selectedChat);
	const isMobileLayout = $derived(!!onMenuClick);
	const hideHeaderForChatTab = $derived(!localSettings.showChatHeader && activeTab === 'chat');
	const showTopHeader = $derived(!hideHeaderForChatTab);
	const showInlineDesktopTabs = $derived(showTopHeader);
	const showFloatingDesktopTabs = $derived(hideHeaderForChatTab && !isMobileLayout);
	const hideFullscreenButtonOnGitTab = $derived(activeTab === 'git' && localSettings.alwaysFullscreenOnGitPanel);
	const canToggleDesktopFullscreen = $derived(
		!isMobileLayout &&
		!!onToggleDesktopFullscreen &&
		!hideFullscreenButtonOnGitTab
	);

	const tabs = CHAT_TOOLBAR_TABS;

	// Holds the chat submit function registered by ConversationWorkspace.
	let chatSubmitFn = $state<((message: string) => Promise<boolean>) | null>(null);

	// Share dialog state.
	let shareChatId = $state<string | null>(null);
	let shareChatTitle = $state('');

	function openShareDialog() {
		if (!selectedChat) return;
		shareChatId = selectedChat.id;
		shareChatTitle = selectedChat.title || 'Untitled Chat';
	}

	function closeShareDialog() {
		shareChatId = null;
		shareChatTitle = '';
	}

	function handleRegisterSubmit(fn: (message: string) => Promise<boolean>): void {
		chatSubmitFn = fn;
	}

	async function handleSendToChat(message: string): Promise<boolean> {
		if (!chatSubmitFn) return false;
		return chatSubmitFn(message);
	}

	function projectDisplayName(projectPath: string | undefined): string {
		if (!projectPath) return 'Unknown';
		const parts = projectPath.split('/').filter(Boolean);
		return parts[parts.length - 1] || projectPath;
	}

	function getTabButtonClasses(tabId: AppTab): string {
		return cn(
			'relative px-2 sm:px-3 py-1 text-xs sm:text-sm font-medium rounded-md transition-all duration-200',
			tabId === activeTab
				? 'bg-chat-tabs-active text-chat-tabs-active-foreground shadow-sm border border-chat-tabs-active-border'
				: 'text-muted-foreground hover:text-foreground hover:bg-accent'
		);
	}

	function getUtilityButtonClasses(): string {
		return cn(
			'relative inline-flex items-center justify-center h-6 sm:h-7 w-6 sm:w-7 px-0 py-0 rounded-md transition-all duration-200',
			'text-muted-foreground hover:text-foreground hover:bg-accent'
		);
	}

	function toggleSplitMode() {
		if (splitLayout.isEnabled) {
			const focusedChat = splitLayout.focusedChatId;
			splitLayout.disable();
			if (focusedChat) sessions.setSelectedChatId(focusedChat);
		} else if (selectedChat) {
			splitLayout.enableWithChat(selectedChat.id);
		}
	}

	function setupGrid() {
		const chatIds = sessions.orderedChats.slice(0, 4).map((c) => c.id);
		if (chatIds.length >= 2) {
			splitLayout.setGrid(chatIds);
		}
	}

	function handleSplitFocusPane(paneId: string) {
		if (splitLayout.focusedPaneId === paneId) return;
		splitLayout.focusPane(paneId);
		const pane = splitLayout.panes.find((p) => p.id === paneId);
		if (pane) sessions.setSelectedChatId(pane.chatId);
	}

	function handleSplitClosePane(paneId: string) {
		splitLayout.closePane(paneId);
		if (!splitLayout.isEnabled) {
			const remaining = splitLayout.focusedChatId;
			if (remaining) sessions.setSelectedChatId(remaining);
		}
	}

	function handleSplitSetRatio(path: number[], ratio: number) {
		splitLayout.setRatioByPath(path, ratio);
	}

	function handleSplitDropChat(paneId: string, zone: 'left' | 'right' | 'top' | 'bottom' | 'center') {
		const draggedChat = splitLayout.draggedChatId;
		if (!draggedChat) return;
		splitLayout.addChatToZone(paneId, draggedChat, zone);
		splitLayout.endDrag();
	}
</script>

<div class="h-full flex flex-col relative">
	{#if !selectedChat?.projectPath}
		<div class="flex-1 min-h-0 overflow-hidden">
			<ChatEmptyState />
		</div>
	{:else}
		<!-- Header with tabs (only shown when a chat is active) -->
		{#if showTopHeader}
			<div class="bg-chat-header border-b border-chat-header-border p-2 flex-shrink-0 text-foreground">
				<div class="flex items-center justify-between relative">
					<div class="flex items-center space-x-2 min-w-0 flex-1">
						{#if onMenuClick}
							<button
								class="p-2 text-muted-foreground hover:text-foreground rounded-md hover:bg-accent md:hidden flex-shrink-0"
								onclick={onMenuClick}
								aria-label={m.main_open_menu()}
							>
								<Menu class="w-5 h-5" />
							</button>
						{/if}
						<div class="min-w-0 flex-1">
							<h2 class="text-[15px] font-semibold text-foreground truncate">
								{selectedChat.title || m.main_new_chat()}
							</h2>
							<div class="text-xs text-muted-foreground truncate">
								{projectDisplayName(selectedChat.projectPath)}
							</div>
						</div>
					</div>

					{#if showInlineDesktopTabs}
						<div class="flex-shrink-0 hidden sm:block">
							<div class="flex items-center gap-1.5">
								<div class="relative flex bg-chat-tabs-rail text-foreground rounded-lg p-0.5 border border-chat-tabs-rail-border">
									{#each tabs as tab (tab.id)}
										<button
											type="button"
											onclick={() => onTabChange(tab.id)}
											class={getTabButtonClasses(tab.id)}
											aria-pressed={tab.id === activeTab}
											title={tab.label()}
										>
											<span class="flex items-center gap-1 sm:gap-1.5">
												<tab.icon class="w-3 sm:w-3.5 h-3 sm:h-3.5" />
												<span class="hidden lg:inline">{tab.label()}</span>
											</span>
										</button>
									{/each}
								</div>
								<div class="relative flex bg-chat-tabs-rail text-foreground rounded-lg p-[3px] border border-chat-tabs-rail-border">
									<button
										type="button"
										onclick={toggleSplitMode}
										class={cn(getUtilityButtonClasses(), splitLayout.isEnabled && 'text-primary bg-primary/10')}
										title={splitLayout.isEnabled ? 'Exit split view' : 'Split view'}
									>
										<span class="flex items-center justify-center">
											<PanelLeft class="w-3 sm:w-3.5 h-3 sm:h-3.5" />
										</span>
									</button>
									{#if splitLayout.isEnabled}
										<button
											type="button"
											onclick={setupGrid}
											class={getUtilityButtonClasses()}
											title="4-up grid (use up to 4 recent chats)"
										>
											<span class="flex items-center justify-center">
												<Grid2x2 class="w-3 sm:w-3.5 h-3 sm:h-3.5" />
											</span>
										</button>
									{/if}
									<button
										type="button"
										onclick={openShareDialog}
										class={getUtilityButtonClasses()}
										title={m.share_button()}
									>
										<span class="flex items-center justify-center">
											<Share2 class="w-3 sm:w-3.5 h-3 sm:h-3.5" />
										</span>
									</button>
									{#if canToggleDesktopFullscreen}
										<button
											type="button"
											onclick={onToggleDesktopFullscreen}
											class={getUtilityButtonClasses()}
											title={isDesktopFullscreen ? m.main_exit_fullscreen() : m.main_enter_fullscreen()}
										>
											<span class="flex items-center justify-center">
												{#if isDesktopFullscreen}
													<Minimize2 class="w-3 sm:w-3.5 h-3 sm:h-3.5" />
												{:else}
													<Maximize2 class="w-3 sm:w-3.5 h-3 sm:h-3.5" />
												{/if}
											</span>
										</button>
									{/if}
								</div>
							</div>
						</div>
					{/if}
				</div>
			</div>
		{/if}

		{#if showFloatingDesktopTabs}
			<div class="absolute right-2 top-2 z-20 hidden sm:block">
				<div class="flex items-center gap-1.5">
					<div class="relative flex bg-chat-tabs-rail text-foreground rounded-lg p-0.5 border border-chat-tabs-rail-border shadow-sm">
						{#each tabs as tab (tab.id)}
							<button
								type="button"
								onclick={() => onTabChange(tab.id)}
								class={getTabButtonClasses(tab.id)}
								aria-pressed={tab.id === activeTab}
								title={tab.label()}
							>
								<span class="flex items-center gap-1 sm:gap-1.5">
									<tab.icon class="w-3 sm:w-3.5 h-3 sm:h-3.5" />
									<span class="hidden lg:inline">{tab.label()}</span>
								</span>
							</button>
						{/each}
					</div>
					<div class="relative flex bg-chat-tabs-rail text-foreground rounded-lg p-[3px] border border-chat-tabs-rail-border shadow-sm">
						<button
							type="button"
							onclick={toggleSplitMode}
							class={cn(getUtilityButtonClasses(), splitLayout.isEnabled && 'text-primary bg-primary/10')}
							title={splitLayout.isEnabled ? 'Exit split view' : 'Split view'}
						>
							<span class="flex items-center justify-center">
								<PanelLeft class="w-3 sm:w-3.5 h-3 sm:h-3.5" />
							</span>
						</button>
						{#if splitLayout.isEnabled}
							<button
								type="button"
								onclick={setupGrid}
								class={getUtilityButtonClasses()}
								title="4-up grid (use up to 4 recent chats)"
							>
								<span class="flex items-center justify-center">
									<Grid2x2 class="w-3 sm:w-3.5 h-3 sm:h-3.5" />
								</span>
							</button>
						{/if}
						<button
							type="button"
							onclick={openShareDialog}
							class={getUtilityButtonClasses()}
							title={m.share_button()}
						>
							<span class="flex items-center justify-center">
								<Share2 class="w-3 sm:w-3.5 h-3 sm:h-3.5" />
							</span>
						</button>
						{#if canToggleDesktopFullscreen}
							<button
								type="button"
								onclick={onToggleDesktopFullscreen}
								class={getUtilityButtonClasses()}
								title={isDesktopFullscreen ? m.main_exit_fullscreen() : m.main_enter_fullscreen()}
							>
								<span class="flex items-center justify-center">
									{#if isDesktopFullscreen}
										<Minimize2 class="w-3 sm:w-3.5 h-3 sm:h-3.5" />
									{:else}
										<Maximize2 class="w-3 sm:w-3.5 h-3 sm:h-3.5" />
									{/if}
								</span>
							</button>
						{/if}
					</div>
				</div>
			</div>
		{/if}

		<!-- Tab content: ConversationWorkspace stays mounted, other tabs lazy-loaded -->
		<div class="flex-1 min-h-0 overflow-hidden">
			{#if splitLayout.isEnabled && splitLayout.root && activeTab === 'chat'}
				{#snippet focusedPaneContent()}
					<ConversationWorkspace onRegisterSubmit={handleRegisterSubmit} />
				{/snippet}
				<SplitContainer
					node={splitLayout.root}
					focusedPaneId={splitLayout.focusedPaneId}
					draggedChatId={splitLayout.draggedChatId}
					onFocusPane={handleSplitFocusPane}
					onClosePane={handleSplitClosePane}
					onSetRatio={handleSplitSetRatio}
					onDropChat={handleSplitDropChat}
					{focusedPaneContent}
				/>
			{:else}
				<div class="h-full" class:hidden={activeTab !== 'chat'}>
					<ConversationWorkspace onRegisterSubmit={handleRegisterSubmit} />
				</div>
			{/if}
			{#if activeTab === 'files'}
				{#await lazyFilesPanel() then { default: FilesPanel }}
					<FilesPanel projectPath={selectedChat.projectPath} chatId={selectedChat.id} />
				{/await}
			{:else if activeTab === 'shell'}
				{#await lazyStandaloneShell() then { default: StandaloneShell }}
					<StandaloneShell initialPath={selectedChat.projectPath!} chatId={selectedChat.id} />
				{/await}
			{:else if activeTab === 'git'}
				{#await lazyGitPanel() then { default: GitPanel }}
					<GitPanel
						chatId={selectedChat.id}
						projectPath={selectedChat.projectPath}
						isMobile={!!onMenuClick}
						onSendToChat={handleSendToChat}
					/>
				{/await}
			{/if}
		</div>
	{/if}

	<ShareChatDialog chatId={shareChatId} chatTitle={shareChatTitle} onClose={closeShareDialog} />
</div>
