<script lang="ts">
	import type { AppTab } from '$lib/types/app';
	import { untrack } from 'svelte';
	import {
		getChatSessions,
		getAppShell,
		getLocalSettings,
		getModelCatalog,
		getSplitLayout,
	} from '$lib/context';
	import Menu from '@lucide/svelte/icons/menu';
	import * as m from '$lib/paraglide/messages.js';
	import ChatEmptyState from '$lib/components/chat/ChatEmptyState.svelte';
	import ChatLoadingState from '$lib/components/chat/ChatLoadingState.svelte';
	import ConversationWorkspace from '$lib/components/chat/ConversationWorkspace.svelte';
	import SplitContainer from '$lib/components/split/SplitContainer.svelte';
	import { SplitPanePreviewStore } from '$lib/chat/split-pane-preview-store.svelte';
	import { ChatTranscriptCache } from '$lib/chat/chat-transcript-cache.svelte';
	import { INITIAL_VISIBLE_MESSAGES } from '$lib/chat/state.svelte';
	import { getSplitPaneTextScale } from '$lib/chat/split-pane-text-scale';
	import { canUseForkAction } from '$lib/chat/fork-at-message-action';
	import { cn } from '$lib/utils/cn';
	import WorkspaceToolbar from './WorkspaceToolbar.svelte';
	import CurrentChatMenu from './CurrentChatMenu.svelte';
	import type { ChatSessionRecord } from '$lib/types/chat-session';
	import {
		SPLIT_DROP_ZONES,
		SplitDropController,
		type SplitDropZone,
	} from './split-drop-controller.svelte';

	// Lazy-loaded tab panels to keep the main chunk lean. Each panel
	// pulls in heavy dependencies (CodeMirror, xterm, git logic).
	const lazyFilesPanel = () => import('$lib/components/files/FilesPanel.svelte');
	const lazyStandaloneShell = () => import('$lib/components/shell/StandaloneShell.svelte');
	const lazyGitPanel = () => import('$lib/components/git/GitPanel.svelte');
	const lazyPullRequestsPanel = () => import('$lib/components/pr/PullRequestsPanel.svelte');

	interface WorkspaceChatActions {
		requestDelete: (chat: ChatSessionRecord) => void;
		requestRename: (chat: ChatSessionRecord) => void;
		requestDetails: (chat: ChatSessionRecord) => void;
		requestShare: (chat: ChatSessionRecord) => void;
		requestProjectPath: (chat: ChatSessionRecord) => void;
		fork: (chat: ChatSessionRecord) => void;
		reload: (chat: ChatSessionRecord) => void;
	}

	const noopChatActions: WorkspaceChatActions = {
		requestDelete() {},
		requestRename() {},
		requestDetails() {},
		requestShare() {},
		requestProjectPath() {},
		fork() {},
		reload() {},
	};

	interface MainContentProps {
		activeTab: AppTab;
		onTabChange: (tab: AppTab) => void;
		onMenuClick?: () => void;
		isDesktopFullscreen?: boolean;
		onToggleDesktopFullscreen?: () => void;
		onRegisterReload?: (fn: (chatId: string) => Promise<void>) => void;
		chatActions?: WorkspaceChatActions;
	}

	let {
		activeTab,
		onTabChange,
		onMenuClick,
		isDesktopFullscreen = false,
		onToggleDesktopFullscreen,
		onRegisterReload,
		chatActions = noopChatActions,
	}: MainContentProps = $props();

	const sessions = getChatSessions();
	const appShell = getAppShell();
	const localSettings = getLocalSettings();
	const modelCatalog = getModelCatalog();
	const splitLayout = getSplitLayout();
	const chatTranscriptCache = new ChatTranscriptCache({ limit: INITIAL_VISIBLE_MESSAGES });
	const splitPanePreviews = new SplitPanePreviewStore(chatTranscriptCache);

	// Derives selected chat from the canonical session store.
	const selectedChat = $derived(sessions.selectedChat);
	const showChatLoadingState = $derived(sessions.isLoadingChats && !selectedChat?.projectPath);
	const isMobileLayout = $derived(!!onMenuClick);
	const isChatTab = $derived(activeTab === 'chat');
	const showTopHeader = $derived(!isChatTab);
	const showFloatingDesktopTabs = $derived(!isMobileLayout && Boolean(selectedChat?.projectPath));
	const showMobileFloatingChatMenu = $derived(
		isMobileLayout && isChatTab && Boolean(selectedChat?.projectPath),
	);
	const hideFullscreenButtonOnGitTab = $derived(
		activeTab === 'git' && localSettings.alwaysFullscreenOnGitPanel,
	);
	const canToggleDesktopFullscreen = $derived(
		!isMobileLayout && !!onToggleDesktopFullscreen && !hideFullscreenButtonOnGitTab,
	);
	const canUpdateSelectedProjectPath = $derived(
		selectedChat
			? (modelCatalog.supportsUpdateProjectPath?.(selectedChat.agentId) ?? false)
			: false,
	);
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
	const floatingDesktopToolbarClass = $derived(
		cn(
			'absolute right-3 z-20 hidden sm:block',
			splitLayout.isEnabled && activeTab === 'chat' ? 'top-8' : 'top-2',
		),
	);
	const splitDropZones = SPLIT_DROP_ZONES;
	const visibleSplitChatIds = $derived(
		splitLayout.isEnabled ? splitLayout.panes.map((pane) => pane.chatId) : [],
	);
	const splitPaneTextScale = $derived(
		splitLayout.isEnabled ? getSplitPaneTextScale(splitLayout.paneCount) : 1,
	);
	const isSplitWorkspaceActive = $derived(splitLayout.isEnabled && Boolean(splitLayout.root));

	// Holds the chat submit function registered by ConversationWorkspace.
	let chatSubmitFn = $state<((message: string) => Promise<boolean>) | null>(null);

	function handleRegisterSubmit(fn: (message: string) => Promise<boolean>): void {
		chatSubmitFn = fn;
	}

	async function handleSendToChat(message: string): Promise<boolean> {
		if (!chatSubmitFn) return false;
		return chatSubmitFn(message);
	}

	function projectDisplayName(projectPath: string | undefined): string {
		if (!projectPath) return m.workspace_unknown();
		const parts = projectPath.split('/').filter(Boolean);
		return parts[parts.length - 1] || projectPath;
	}

	function toggleSplitMode() {
		if (splitLayout.isEnabled) {
			const focusedChat = splitLayout.focusedChatId;
			splitLayout.disable();
			if (focusedChat) sessions.setSelectedChatId(focusedChat);
			return;
		}
		if (!selectedChat) return;
		splitLayout.enableWithChat(selectedChat.id);
		// A lone pane is not a useful split, so pair the current chat with
		// the most recent other chat right away when one exists.
		const companionChat = sessions.orderedChats.find((chat) => chat.id !== selectedChat.id);
		const initialPane = splitLayout.panes[0];
		if (companionChat && initialPane) {
			splitLayout.splitPane(initialPane.id, 'horizontal', companionChat.id);
			splitLayout.focusPane(initialPane.id);
		}
	}

	function handleSplitFocusPane(paneId: string) {
		if (splitLayout.focusedPaneId === paneId) return;
		splitLayout.focusPane(paneId);
		const pane = splitLayout.panes.find((p) => p.id === paneId);
		if (pane) sessions.setSelectedChatId(pane.chatId);
		appShell.requestComposerFocus();
	}

	function handleSplitClosePane(paneId: string) {
		// Capture the other pane's chatId before closing, since disable() clears state.
		const otherChat = splitLayout.panes.find((p) => p.id !== paneId)?.chatId;
		splitLayout.closePane(paneId);
		if (!splitLayout.isEnabled && otherChat) {
			sessions.setSelectedChatId(otherChat);
		}
	}

	function handleSplitMaximizePane(paneId: string) {
		const pane = splitLayout.panes.find((entry) => entry.id === paneId);
		if (!pane) return;
		splitLayout.disable();
		sessions.setSelectedChatId(pane.chatId);
	}

	function handleSplitSetRatio(path: number[], ratio: number) {
		splitLayout.setRatioByPath(path, ratio);
	}

	function handleSplitDropChat(paneId: string, zone: SplitDropZone) {
		const draggedChat = splitLayout.draggedChatId;
		if (!draggedChat) return;
		// Pane-to-pane drag: always swap regardless of zone to prevent duplication.
		if (splitLayout.draggedPaneId) {
			splitLayout.swapPanes(splitLayout.draggedPaneId, paneId);
			splitLayout.endDrag();
			syncFocusedChatToSessions();
			return;
		}
		const existingPane = splitLayout.panes.find((p) => p.chatId === draggedChat);
		if (existingPane) {
			splitLayout.focusPane(existingPane.id);
			splitLayout.endDrag();
			syncFocusedChatToSessions();
			return;
		}
		splitLayout.addChatToZone(paneId, draggedChat, zone);
		splitLayout.endDrag();
		syncFocusedChatToSessions();
	}

	function handleWorkspaceDragOver(event: DragEvent): void {
		if (isSplitWorkspaceActive) return;
		splitDrop.handleWorkspaceDragOver(event);
	}

	function handleWorkspaceDragLeave(event: DragEvent): void {
		if (isSplitWorkspaceActive) return;
		splitDrop.handleWorkspaceDragLeave(event);
	}

	function handleWorkspaceDrop(event: DragEvent): void {
		if (isSplitWorkspaceActive) return;
		splitDrop.handleWorkspaceDrop(event);
	}

	// Syncs the focused pane's chat to sessions.selectedChatId.
	function syncFocusedChatToSessions() {
		const focusedChat = splitLayout.focusedChatId;
		if (focusedChat) sessions.setSelectedChatId(focusedChat);
	}

	function getVisibleSplitChatIds(): string[] {
		return visibleSplitChatIds;
	}

	function isVisibleSplitChat(chatId: string): boolean {
		return visibleSplitChatIds.includes(chatId);
	}

	let splitRootEl: HTMLDivElement | undefined = $state();
	const splitDrop = new SplitDropController({
		get activeTab() {
			return activeTab;
		},
		get selectedChatId() {
			return selectedChat?.id ?? null;
		},
		get splitLayout() {
			return splitLayout;
		},
		get splitRootEl() {
			return splitRootEl;
		},
	});
	const focusedOverlayRect = $derived(splitDrop.focusedOverlayRect);
	const conversationWorkspaceLayerClass = $derived(
		cn(
			'absolute overflow-hidden bg-background',
			isSplitWorkspaceActive ? 'rounded-b-lg pointer-events-auto' : 'inset-0',
			isSplitWorkspaceActive && !focusedOverlayRect && 'invisible pointer-events-none',
		),
	);
	const conversationWorkspaceTop = $derived(
		isSplitWorkspaceActive ? `${focusedOverlayRect?.top ?? 0}px` : undefined,
	);
	const conversationWorkspaceLeft = $derived(
		isSplitWorkspaceActive ? `${focusedOverlayRect?.left ?? 0}px` : undefined,
	);
	const conversationWorkspaceWidth = $derived(
		isSplitWorkspaceActive ? `${focusedOverlayRect?.width ?? 0}px` : undefined,
	);
	const conversationWorkspaceHeight = $derived(
		isSplitWorkspaceActive ? `${focusedOverlayRect?.height ?? 0}px` : undefined,
	);
	const conversationWorkspaceVisible = $derived(
		activeTab === 'chat' && (!isSplitWorkspaceActive || Boolean(focusedOverlayRect)),
	);
	const conversationWorkspaceTextScale = $derived(isSplitWorkspaceActive ? splitPaneTextScale : 1);

	// Keeps sessions.selectedChatId in sync with the split layout's focused pane.
	// Handles sidebar clicks (which only update sessions) by navigating the focused
	// pane to the selected chat, or focusing an existing pane that already shows it.
	$effect(() => {
		const isEnabled = splitLayout.isEnabled;
		const selChat = selectedChat;
		if (!isEnabled || !selChat) return;

		untrack(() => {
			const focusedChat = splitLayout.focusedChatId;
			if (selChat.id === focusedChat) return;

			const existingPane = splitLayout.panes.find((p) => p.chatId === selChat.id);
			if (existingPane) {
				splitLayout.focusPane(existingPane.id);
			} else if (splitLayout.focusedPaneId) {
				splitLayout.replacePaneChat(splitLayout.focusedPaneId, selChat.id);
			}
		});
	});

	$effect(() => {
		const chatIds = visibleSplitChatIds;
		untrack(() => splitPanePreviews.prune(chatIds));
	});
</script>

{#snippet currentChatMenu(shadow: boolean)}
	{#if selectedChat}
		<CurrentChatMenu
			{selectedChat}
			{isMobileLayout}
			splitEnabled={splitLayout.isEnabled}
			canToggleSplitView={activeTab === 'chat'}
			{isDesktopFullscreen}
			{canToggleDesktopFullscreen}
			canReload={isChatTab}
			canUpdateProjectPath={canUpdateSelectedProjectPath}
			canFork={canForkSelectedChat}
			canForkNow={canForkSelectedChatNow}
			{shadow}
			onToggleSplitMode={toggleSplitMode}
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
{/snippet}

<div class="h-full flex flex-col relative">
	{#if showChatLoadingState}
		<div class="flex-1 min-h-0 overflow-hidden">
			<ChatLoadingState />
		</div>
	{:else if !selectedChat?.projectPath}
		<div class="flex-1 min-h-0 overflow-hidden">
			<ChatEmptyState />
		</div>
	{:else}
		<!-- Header with tabs (only shown when a chat is active) -->
		{#if showTopHeader}
			<div
				class="bg-chat-header border-b border-chat-header-border p-2 flex-shrink-0 text-foreground"
			>
				<div
					class={cn(
						'flex items-center justify-between relative',
						showFloatingDesktopTabs ? 'sm:pr-56 lg:pr-[22rem]' : '',
					)}
				>
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

					{#if isMobileLayout}
						<div class="flex-shrink-0 sm:hidden">
							{@render currentChatMenu(false)}
						</div>
					{/if}
				</div>
			</div>
		{/if}

		{#if showFloatingDesktopTabs}
			<div data-floating-workspace-toolbar class={floatingDesktopToolbarClass}>
				<WorkspaceToolbar {activeTab} shadow {onTabChange}>
					{#snippet actionMenu()}
						{@render currentChatMenu(true)}
					{/snippet}
				</WorkspaceToolbar>
			</div>
		{/if}

		{#if showMobileFloatingChatMenu}
			<div data-mobile-current-chat-menu class="absolute right-3 top-3 z-20 sm:hidden">
				{@render currentChatMenu(true)}
			</div>
		{/if}

		<!-- Tab content: ConversationWorkspace stays mounted, other tabs lazy-loaded -->
		<div class="flex-1 min-h-0 overflow-hidden">
			<!-- svelte-ignore a11y_no_static_element_interactions -- drop target for initiating split mode and focused-pane measurement root -->
			<div
				class={cn('h-full relative', activeTab !== 'chat' && 'hidden')}
				bind:this={splitRootEl}
				ondragover={handleWorkspaceDragOver}
				ondragleave={handleWorkspaceDragLeave}
				ondrop={handleWorkspaceDrop}
			>
				{#if isSplitWorkspaceActive && splitLayout.root}
					<SplitContainer
						node={splitLayout.root}
						focusedPaneId={splitLayout.focusedPaneId}
						previewStore={splitPanePreviews}
						textScale={splitPaneTextScale}
						onFocusPane={handleSplitFocusPane}
						onClosePane={handleSplitClosePane}
						onMaximizePane={handleSplitMaximizePane}
						onSetRatio={handleSplitSetRatio}
					/>
					{#if splitLayout.paneCount === 1}
						<div
							class="absolute bottom-4 left-1/2 -translate-x-1/2 z-30 pointer-events-none"
							data-split-single-pane-hint
						>
							<span
								class="rounded-md bg-muted/90 border border-border px-3 py-1.5 text-xs text-muted-foreground shadow-sm"
							>
								{m.workspace_split_single_pane_hint()}
							</span>
						</div>
					{/if}
					<!--
						The interactive workspace is rendered once at a stable
						location and positioned either full-frame or over the
						focused pane. Split toggles and focus changes only
						update wrapper CSS, so ConversationWorkspace is not
						remounted.
					-->
				{/if}
				<div
					data-focused-split-overlay={isSplitWorkspaceActive ? true : undefined}
					data-conversation-workspace-layer
					class={conversationWorkspaceLayerClass}
					style:top={conversationWorkspaceTop}
					style:left={conversationWorkspaceLeft}
					style:width={conversationWorkspaceWidth}
					style:height={conversationWorkspaceHeight}
				>
					<ConversationWorkspace
						onRegisterSubmit={handleRegisterSubmit}
						{onRegisterReload}
						transcriptCache={chatTranscriptCache}
						reserveTopFloatingToolbar={showFloatingDesktopTabs || showMobileFloatingChatMenu}
						reserveFeedTopFloatingToolbar={showFloatingDesktopTabs}
						isVisible={conversationWorkspaceVisible}
						textScale={conversationWorkspaceTextScale}
						getVisibleChatIds={getVisibleSplitChatIds}
						isVisiblePreviewChat={isVisibleSplitChat}
						getVisiblePreviewCursor={(chatId) => splitPanePreviews.cursor(chatId)}
						applyVisiblePreviewMessages={(chatId, generationId, messages, lastSeq) =>
							splitPanePreviews.applyMessages(chatId, generationId, messages, lastSeq)}
						loadVisiblePreviewSnapshot={(chatId) => splitPanePreviews.loadSnapshot(chatId)}
						markVisiblePreviewStale={(chatId) => splitPanePreviews.markStale(chatId)}
					/>
				</div>
				{#if splitDrop.workspaceDragOver && !isSplitWorkspaceActive}
					<div
						class="absolute inset-0 z-30 flex items-center justify-center bg-primary/5 border-2 border-dashed border-primary/30 rounded-lg pointer-events-none"
					>
						<span class="text-sm font-medium text-primary bg-primary/10 px-3 py-1.5 rounded-md"
							>{m.workspace_drop_to_split_view()}</span
						>
					</div>
				{/if}
				{#if splitDrop.showActiveSplitDropLayer}
					<!-- svelte-ignore a11y_no_static_element_interactions -- drag target only exists during native drag-and-drop -->
					<div
						class="absolute inset-0 z-40 pointer-events-auto"
						data-split-drag-layer
						ondragover={(event) => splitDrop.handleActiveSplitDragOver(event)}
						ondragleave={(event) => splitDrop.handleActiveSplitDragLeave(event)}
						ondrop={(event) => splitDrop.handleActiveSplitDrop(event, handleSplitDropChat)}
						role="region"
						aria-label={m.workspace_split_drop_target()}
					>
						<div
							class={cn(
								'absolute inset-0 pointer-events-none transition-colors duration-150',
								splitDrop.activeSplitDropTarget
									? 'bg-background/45 backdrop-blur-[1px]'
									: 'bg-background/20',
							)}
						></div>
						{#if splitDrop.activeSplitDropTarget}
							<div
								class="absolute pointer-events-none transition-all duration-150"
								style={splitDrop.activeTargetStyle()}
							>
								<!-- Target map shows every droppable region while dragging. -->
								{#each splitDropZones as dropZone (dropZone.zone)}
									<div
										data-split-zone={dropZone.zone}
										class={cn(
											'absolute rounded-md transition-all duration-150',
											dropZone.hitInsetClass,
											splitDrop.zoneMapClass(dropZone.zone),
										)}
									></div>
								{/each}
								<!-- Outcome preview shows where the hovered drop lands. -->
								{#if splitDrop.activeResultInset}
									<div
										data-split-drop-result
										class={cn(
											'absolute rounded-lg flex items-center justify-center transition-all duration-150',
											splitDrop.activeResultInset,
											splitDrop.resultToneClass(),
										)}
									>
										<span
											class={cn(
												'rounded-md px-2 py-0.5 text-[10px] font-medium shadow-sm',
												splitDrop.resultLabelClass(),
											)}>{splitDrop.resultLabel()}</span
										>
									</div>
								{/if}
							</div>
						{/if}
					</div>
				{/if}
			</div>
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
			{:else if activeTab === 'pull-requests'}
				{#await lazyPullRequestsPanel() then { default: PullRequestsPanel }}
					<PullRequestsPanel
						projectPath={selectedChat.projectPath}
						isMobile={!!onMenuClick}
						onSendToChat={handleSendToChat}
						onNavigateToChat={() => onTabChange('chat')}
					/>
				{/await}
			{/if}
		</div>
	{/if}
</div>
