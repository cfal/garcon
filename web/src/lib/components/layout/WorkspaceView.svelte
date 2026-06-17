<script lang="ts">
	import type { AppTab } from '$lib/types/app';
	import { untrack } from 'svelte';
	import {
		getChatSessions,
		getLocalSettings,
		getSplitLayout,
	} from '$lib/context';
	import Menu from '@lucide/svelte/icons/menu';
	import * as m from '$lib/paraglide/messages.js';
	import ChatEmptyState from '$lib/components/chat/ChatEmptyState.svelte';
	import ConversationWorkspace from '$lib/components/chat/ConversationWorkspace.svelte';
	import ShareChatDialog from '$lib/components/chat/ShareChatDialog.svelte';
	import SplitContainer from '$lib/components/split/SplitContainer.svelte';
	import { SplitPanePreviewStore } from '$lib/chat/split-pane-preview-store.svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { cn } from '$lib/utils/cn';
	import WorkspaceToolbar from './WorkspaceToolbar.svelte';
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

	interface MainContentProps {
		activeTab: AppTab;
		onTabChange: (tab: AppTab) => void;
		onMenuClick?: () => void;
		isDesktopFullscreen?: boolean;
		onToggleDesktopFullscreen?: () => void;
		onRegisterReload?: (fn: (chatId: string) => Promise<void>) => void;
	}

	let {
		activeTab,
		onTabChange,
		onMenuClick,
		isDesktopFullscreen = false,
		onToggleDesktopFullscreen,
		onRegisterReload,
	}: MainContentProps = $props();

	const sessions = getChatSessions();
	const localSettings = getLocalSettings();
	const splitLayout = getSplitLayout();
	const splitPanePreviews = new SplitPanePreviewStore();

	// Derives selected chat from the canonical session store.
	const selectedChat = $derived(sessions.selectedChat);
	const isMobileLayout = $derived(!!onMenuClick);
	const isChatTab = $derived(activeTab === 'chat');
	const showTopHeader = $derived(!isChatTab);
	const showInlineDesktopTabs = $derived(showTopHeader);
	const showFloatingDesktopTabs = $derived(isChatTab && !isMobileLayout);
	const hideFullscreenButtonOnGitTab = $derived(
		activeTab === 'git' && localSettings.alwaysFullscreenOnGitPanel,
	);
	const canToggleDesktopFullscreen = $derived(
		!isMobileLayout && !!onToggleDesktopFullscreen && !hideFullscreenButtonOnGitTab,
	);

	const splitViewTooltip = $derived(
		splitLayout.isEnabled ? m.workspace_exit_split_view() : m.workspace_split_view(),
	);
	const fullscreenTooltip = $derived(
		isDesktopFullscreen ? m.main_exit_fullscreen() : m.main_enter_fullscreen(),
	);
	const splitDropZones = SPLIT_DROP_ZONES;
	const visibleSplitChatIds = $derived(
		splitLayout.isEnabled ? splitLayout.panes.map((pane) => pane.chatId) : [],
	);

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

	// Delete confirmation state for split-pane delete action.
	let deleteConfirmation = $state<{ paneId: string; chatId: string; chatTitle: string } | null>(
		null,
	);

	function handleSplitDeleteChat(paneId: string) {
		const pane = splitLayout.panes.find((p) => p.id === paneId);
		if (!pane) return;
		const record = sessions.byId[pane.chatId];
		deleteConfirmation = {
			paneId,
			chatId: pane.chatId,
			chatTitle: record?.title || 'Untitled',
		};
	}

	async function confirmSplitDelete() {
		if (!deleteConfirmation) return;
		const { paneId, chatId } = deleteConfirmation;
		deleteConfirmation = null;
		// Close the pane first, then delete the chat server-side.
		handleSplitClosePane(paneId);
		await sessions.deleteRemoteChat(chatId);
	}

	function cancelSplitDelete() {
		deleteConfirmation = null;
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
			sessions.setSelectedChatId(chatIds[0]);
		}
	}

	function handleSplitFocusPane(paneId: string) {
		if (splitLayout.focusedPaneId === paneId) return;
		splitLayout.focusPane(paneId);
		const pane = splitLayout.panes.find((p) => p.id === paneId);
		if (pane) sessions.setSelectedChatId(pane.chatId);
	}

	function handleSplitClosePane(paneId: string) {
		// Capture the other pane's chatId before closing, since disable() clears state.
		const otherChat = splitLayout.panes.find((p) => p.id !== paneId)?.chatId;
		splitLayout.closePane(paneId);
		if (!splitLayout.isEnabled && otherChat) {
			sessions.setSelectedChatId(otherChat);
		}
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
</script>

<div class="h-full flex flex-col relative">
	{#if !selectedChat?.projectPath}
		<div class="flex-1 min-h-0 overflow-hidden">
			<ChatEmptyState />
		</div>
	{:else}
		<!-- Header with tabs (only shown when a chat is active) -->
		{#if showTopHeader}
			<div
				class="bg-chat-header border-b border-chat-header-border p-2 flex-shrink-0 text-foreground"
			>
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
							<WorkspaceToolbar
								{activeTab}
								splitEnabled={splitLayout.isEnabled}
								{splitViewTooltip}
								{fullscreenTooltip}
								showFullscreenButton={canToggleDesktopFullscreen}
								{isDesktopFullscreen}
								{onTabChange}
								onToggleSplitMode={toggleSplitMode}
								onSetupGrid={setupGrid}
								onShare={openShareDialog}
								{onToggleDesktopFullscreen}
							/>
						</div>
					{/if}
				</div>
			</div>
		{/if}

		{#if showFloatingDesktopTabs}
			<div
				data-floating-workspace-toolbar
				class="absolute right-6 top-3 z-20 hidden sm:block md:right-8"
			>
				<WorkspaceToolbar
					{activeTab}
					splitEnabled={splitLayout.isEnabled}
					{splitViewTooltip}
					{fullscreenTooltip}
					showFullscreenButton={canToggleDesktopFullscreen}
					{isDesktopFullscreen}
					shadow
					{onTabChange}
					onToggleSplitMode={toggleSplitMode}
					onSetupGrid={setupGrid}
					onShare={openShareDialog}
					{onToggleDesktopFullscreen}
				/>
			</div>
		{/if}

		<!-- Tab content: ConversationWorkspace stays mounted, other tabs lazy-loaded -->
		<div class="flex-1 min-h-0 overflow-hidden">
			{#if splitLayout.isEnabled && splitLayout.root && activeTab === 'chat'}
				<!-- svelte-ignore a11y_no_static_element_interactions -- container tracks focused pane rect -->
				<div class="h-full relative" bind:this={splitRootEl}>
					<SplitContainer
						node={splitLayout.root}
						focusedPaneId={splitLayout.focusedPaneId}
						draggedChatId={splitLayout.draggedChatId}
						previewStore={splitPanePreviews}
						onFocusPane={handleSplitFocusPane}
						onClosePane={handleSplitClosePane}
						onDeleteChat={handleSplitDeleteChat}
						onSetRatio={handleSplitSetRatio}
						onDropChat={handleSplitDropChat}
					/>
					<!--
						The interactive workspace is rendered once at a stable
						location and positioned over the focused pane. Focus
						changes only update the overlay's rect via CSS, so the
						ConversationWorkspace is never remounted. All panes
						render uniformly; switching focus triggers no side
						effects beyond the chat switch inside the workspace.
					-->
					{#if splitDrop.focusedOverlayRect}
						<div
							class="absolute pointer-events-auto rounded-lg overflow-hidden bg-background border border-primary/40 shadow-sm shadow-primary/10"
							style:top="{splitDrop.focusedOverlayRect.top}px"
							style:left="{splitDrop.focusedOverlayRect.left}px"
							style:width="{splitDrop.focusedOverlayRect.width}px"
							style:height="{splitDrop.focusedOverlayRect.height}px"
						>
							<ConversationWorkspace
								onRegisterSubmit={handleRegisterSubmit}
								{onRegisterReload}
								reserveTopFloatingToolbar={showFloatingDesktopTabs}
								getVisibleChatIds={getVisibleSplitChatIds}
								isVisiblePreviewChat={isVisibleSplitChat}
								getVisiblePreviewCursor={(chatId) => splitPanePreviews.cursor(chatId)}
								applyVisiblePreviewMessages={(chatId, generationId, messages, lastSeq) =>
									splitPanePreviews.applyMessages(chatId, generationId, messages, lastSeq)}
								loadVisiblePreviewSnapshot={(chatId) => splitPanePreviews.loadSnapshot(chatId)}
								markVisiblePreviewStale={(chatId) => splitPanePreviews.markStale(chatId)}
							/>
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
									{#each splitDropZones as dropZone (dropZone.zone)}
										<div
											class={cn(
												'absolute border rounded-lg transition-opacity duration-150',
												splitDrop.previewTone(dropZone.zone),
												splitDrop.previewClass(dropZone.zone),
												dropZone.insetClass,
											)}
										>
											<div class="flex h-full items-center justify-center">
												<span
													class={cn(
														'rounded-md px-2 py-0.5 text-[10px] font-medium shadow-sm',
														splitDrop.previewLabelClass(dropZone.zone),
													)}>{splitDrop.previewLabel(dropZone.zone, dropZone.label())}</span
												>
											</div>
										</div>
									{/each}
								</div>
							{/if}
						</div>
					{/if}
				</div>
			{:else}
				<!-- svelte-ignore a11y_no_static_element_interactions -- drop target for initiating split mode -->
				<div
					class="h-full relative"
					class:hidden={activeTab !== 'chat'}
					ondragover={(event) => splitDrop.handleWorkspaceDragOver(event)}
					ondragleave={() => splitDrop.handleWorkspaceDragLeave()}
					ondrop={(event) => splitDrop.handleWorkspaceDrop(event)}
				>
					<ConversationWorkspace
						onRegisterSubmit={handleRegisterSubmit}
						{onRegisterReload}
						reserveTopFloatingToolbar={showFloatingDesktopTabs}
					/>
					{#if splitDrop.workspaceDragOver}
						<div
							class="absolute inset-0 z-30 flex items-center justify-center bg-primary/5 border-2 border-dashed border-primary/30 rounded-lg pointer-events-none"
						>
							<span class="text-sm font-medium text-primary bg-primary/10 px-3 py-1.5 rounded-md"
								>{m.workspace_drop_to_split_view()}</span
							>
						</div>
					{/if}
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

	<!-- Delete confirmation dialog for split-pane delete action -->
	<Dialog.Root
		open={deleteConfirmation !== null}
		onOpenChange={(open) => {
			if (!open) cancelSplitDelete();
		}}
	>
		<Dialog.Content>
			<Dialog.Header class="min-w-0">
				<Dialog.Title>{m.sidebar_delete_confirmation_delete_chat()}</Dialog.Title>
				<Dialog.Description class="min-w-0 max-w-full">
					<span class="font-medium text-foreground block w-full min-w-0 max-w-full truncate">
						{deleteConfirmation?.chatTitle || m.sidebar_chats_unnamed()}
					</span>
					{m.sidebar_delete_confirmation_cannot_undo()}
				</Dialog.Description>
			</Dialog.Header>
			<Dialog.Footer>
				<Button variant="outline" onclick={cancelSplitDelete}>{m.sidebar_actions_cancel()}</Button>
				<Button
					variant="destructive"
					onclick={() => {
						void confirmSplitDelete();
					}}>{m.sidebar_actions_delete()}</Button
				>
			</Dialog.Footer>
		</Dialog.Content>
	</Dialog.Root>
</div>
