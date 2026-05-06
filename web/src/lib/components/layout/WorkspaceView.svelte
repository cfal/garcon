<script lang="ts">
	import type { AppTab } from '$lib/types/app';
	import { untrack } from 'svelte';
	import { getChatSessions, getLocalSettings, getSplitLayout, getAppShell } from '$lib/context';
	import { deleteChat } from '$lib/api/chats';
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
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { cn } from '$lib/utils/cn';
	import { CHAT_TOOLBAR_TABS } from './chat-toolbar-tabs';

	type SplitDropZone = 'left' | 'right' | 'top' | 'bottom' | 'center';
	type ActiveSplitDropTarget = {
		paneId: string;
		zone: SplitDropZone;
		rect: DOMRect;
		blockedReason?: 'max-panes';
	};

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
	const appShell = getAppShell();

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

	// Delete confirmation state for split-pane delete action.
	let deleteConfirmation = $state<{ paneId: string; chatId: string; chatTitle: string } | null>(null);

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
		try {
			await deleteChat(chatId);
			appShell.quietRefreshChats();
		} catch (err) {
			console.error('[WorkspaceView] Failed to delete chat:', err);
		}
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

	function getTabButtonClasses(tabId: AppTab): string {
		return cn(
			'relative px-2 sm:px-3 py-1 text-xs sm:text-sm font-medium rounded-md transition-colors duration-150',
			tabId === activeTab
				? 'bg-chat-tabs-active text-chat-tabs-active-foreground shadow-sm border border-chat-tabs-active-border'
				: 'text-muted-foreground hover:text-foreground hover:bg-accent'
		);
	}

	function getUtilityButtonClasses(): string {
		return cn(
			'relative inline-flex items-center justify-center h-6 sm:h-7 w-6 sm:w-7 px-0 py-0 rounded-md transition-colors duration-150',
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
		splitLayout.addChatToZone(paneId, draggedChat, zone);
		splitLayout.endDrag();
		syncFocusedChatToSessions();
	}

	// Syncs the focused pane's chat to sessions.selectedChatId.
	function syncFocusedChatToSessions() {
		const focusedChat = splitLayout.focusedChatId;
		if (focusedChat) sessions.setSelectedChatId(focusedChat);
	}

	// Handles dropping a chat on the main workspace when split mode is off.
	// Auto-enables split with the current chat, then splits in the dropped chat.
	let workspaceDragOver = $state(false);
	let activeSplitDropTarget = $state<ActiveSplitDropTarget | null>(null);
	const showActiveSplitDropLayer = $derived(
		splitLayout.isEnabled && activeTab === 'chat' && splitLayout.draggedChatId !== null,
	);

	function handleWorkspaceDragOver(e: DragEvent) {
		if (splitLayout.isEnabled) return;
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
		workspaceDragOver = true;
	}

	function handleWorkspaceDragLeave() {
		workspaceDragOver = false;
	}

	function handleWorkspaceDrop(e: DragEvent) {
		e.preventDefault();
		workspaceDragOver = false;
		const draggedChat = splitLayout.draggedChatId;
		if (!draggedChat || !selectedChat) return;
		if (draggedChat === selectedChat.id) return;
		splitLayout.enableWithChat(selectedChat.id);
		const initialPane = splitLayout.panes[0];
		if (initialPane) {
			splitLayout.splitPane(initialPane.id, 'horizontal', draggedChat);
			// Keep focus on the original chat pane, not the dragged one.
			splitLayout.focusPane(initialPane.id);
		}
		splitLayout.endDrag();
	}

	function resolveDropZone(rect: DOMRect, clientX: number, clientY: number): SplitDropZone {
		const x = clientX - rect.left;
		const y = clientY - rect.top;
		const edgeX = rect.width * 0.25;
		const edgeY = rect.height * 0.25;

		if (y < edgeY) return 'top';
		if (y > rect.height - edgeY) return 'bottom';
		if (x < edgeX) return 'left';
		if (x > rect.width - edgeX) return 'right';
		return 'center';
	}

	function isSplitEdgeZone(zone: SplitDropZone): boolean {
		return zone !== 'center';
	}

	function toActiveSplitDropTarget(
		paneId: string,
		zone: SplitDropZone,
		rect: DOMRect,
	): ActiveSplitDropTarget {
		return {
			paneId,
			zone,
			rect,
			blockedReason:
				splitLayout.paneCount >= 4 && isSplitEdgeZone(zone) ? 'max-panes' : undefined,
		};
	}

	function resolveActiveSplitDropTarget(e: DragEvent): ActiveSplitDropTarget | null {
		if (!splitRootEl) return null;

		let fallback: { paneId: string; rect: DOMRect; distance: number } | null = null;
		for (const pane of splitLayout.panes) {
			const paneEl = splitRootEl.querySelector<HTMLElement>(`[data-pane-id="${pane.id}"]`);
			if (!paneEl) continue;

			const rect = paneEl.getBoundingClientRect();
			const containsPointer =
				e.clientX >= rect.left &&
				e.clientX <= rect.right &&
				e.clientY >= rect.top &&
				e.clientY <= rect.bottom;
			if (containsPointer) {
				return toActiveSplitDropTarget(
					pane.id,
					resolveDropZone(rect, e.clientX, e.clientY),
					rect,
				);
			}

			const centerX = rect.left + rect.width / 2;
			const centerY = rect.top + rect.height / 2;
			const distance = Math.hypot(e.clientX - centerX, e.clientY - centerY);
			if (!fallback || distance < fallback.distance) {
				fallback = { paneId: pane.id, rect, distance };
			}
		}

		if (!fallback) return null;
		return toActiveSplitDropTarget(
			fallback.paneId,
			resolveDropZone(fallback.rect, e.clientX, e.clientY),
			fallback.rect,
		);
	}

	function handleActiveSplitDragOver(e: DragEvent) {
		if (!showActiveSplitDropLayer) return;
		const target = resolveActiveSplitDropTarget(e);
		if (!target) return;

		e.preventDefault();
		e.stopPropagation();
		if (e.dataTransfer) e.dataTransfer.dropEffect = target.blockedReason ? 'none' : 'move';
		activeSplitDropTarget = target;
	}

	function handleActiveSplitDrop(e: DragEvent) {
		if (!showActiveSplitDropLayer) return;
		e.preventDefault();
		e.stopPropagation();

		const target = activeSplitDropTarget ?? resolveActiveSplitDropTarget(e);
		activeSplitDropTarget = null;
		if (!target) {
			splitLayout.endDrag();
			return;
		}
		if (target.blockedReason) {
			splitLayout.endDrag();
			return;
		}

		handleSplitDropChat(target.paneId, target.zone);
	}

	function handleActiveSplitDragLeave(e: DragEvent) {
		const related = e.relatedTarget as HTMLElement | null;
		if (!related || !(e.currentTarget as HTMLElement).contains(related)) {
			activeSplitDropTarget = null;
		}
	}

	function getActiveSplitPreviewClass(zone: SplitDropZone): string {
		if (!activeSplitDropTarget || activeSplitDropTarget.zone !== zone) return 'opacity-0';
		return 'opacity-100';
	}

	function getActiveSplitPreviewTone(zone: SplitDropZone): string {
		if (
			activeSplitDropTarget?.zone === zone &&
			activeSplitDropTarget.blockedReason === 'max-panes'
		) {
			return 'bg-destructive/10 border-destructive/40';
		}
		return zone === 'center'
			? 'bg-accent/15 border-accent/40'
			: 'bg-primary/12 border-primary/30';
	}

	function getActiveSplitPreviewLabel(zone: SplitDropZone, fallback: string): string {
		if (
			activeSplitDropTarget?.zone === zone &&
			activeSplitDropTarget.blockedReason === 'max-panes'
		) {
			return '4 panes max';
		}
		return fallback;
	}

	function getActiveSplitPreviewLabelClass(zone: SplitDropZone): string {
		if (
			activeSplitDropTarget?.zone === zone &&
			activeSplitDropTarget.blockedReason === 'max-panes'
		) {
			return 'bg-destructive/10 text-destructive';
		}
		return zone === 'center'
			? 'bg-accent/15 text-accent-foreground'
			: 'bg-primary/10 text-primary';
	}

	function getActiveSplitTargetStyle(): string {
		if (!splitRootEl || !activeSplitDropTarget) return '';

		const rootRect = splitRootEl.getBoundingClientRect();
		const rect = activeSplitDropTarget.rect;
		return [
			`top:${rect.top - rootRect.top}px`,
			`left:${rect.left - rootRect.left}px`,
			`width:${rect.width}px`,
			`height:${rect.height}px`,
		].join(';');
	}

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

	// Focused-pane overlay tracking. The interactive ConversationWorkspace
	// lives at a stable DOM location and is positioned over the focused
	// pane's body via an absolute overlay. Focus changes only reposition
	// the overlay rect; ConversationWorkspace is never remounted.
	let splitRootEl: HTMLDivElement | undefined = $state();
	let focusedOverlayRect = $state<{ top: number; left: number; width: number; height: number } | null>(null);

	$effect(() => {
		const focusedId = splitLayout.focusedPaneId;
		const isEnabled = splitLayout.isEnabled;
		// Also depend on the tree identity so mount/unmount of panes re-runs this.
		const _rootIdentity = splitLayout.root;
		const root = splitRootEl;

		if (!isEnabled || !focusedId || !root) {
			focusedOverlayRect = null;
			return;
		}

		let paneEl: HTMLElement | null = null;
		const update = () => {
			if (!root) return;
			paneEl = root.querySelector<HTMLElement>(
				`[data-pane-id="${focusedId}"] [data-pane-body]`,
			);
			if (!paneEl) {
				focusedOverlayRect = null;
				return;
			}
			const rootRect = root.getBoundingClientRect();
			const r = paneEl.getBoundingClientRect();
			focusedOverlayRect = {
				top: r.top - rootRect.top,
				left: r.left - rootRect.left,
				width: r.width,
				height: r.height,
			};
		};

		// Initial + poll on next frame so the just-rendered tree is present.
		update();
		const rafId = requestAnimationFrame(update);

		const ro = new ResizeObserver(update);
		ro.observe(root);
		if (paneEl) ro.observe(paneEl);

		const onWinResize = () => update();
		window.addEventListener('resize', onWinResize);
		return () => {
			cancelAnimationFrame(rafId);
			ro.disconnect();
			window.removeEventListener('resize', onWinResize);
		};
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
				<!-- svelte-ignore a11y_no_static_element_interactions -- container tracks focused pane rect -->
				<div class="h-full relative" bind:this={splitRootEl}>
					<SplitContainer
						node={splitLayout.root}
						focusedPaneId={splitLayout.focusedPaneId}
						draggedChatId={splitLayout.draggedChatId}
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
					{#if focusedOverlayRect}
						<div
							class="absolute pointer-events-auto rounded-lg overflow-hidden bg-background border border-primary/40 shadow-sm shadow-primary/10"
							style:top="{focusedOverlayRect.top}px"
							style:left="{focusedOverlayRect.left}px"
							style:width="{focusedOverlayRect.width}px"
							style:height="{focusedOverlayRect.height}px"
						>
							<ConversationWorkspace onRegisterSubmit={handleRegisterSubmit} />
						</div>
					{/if}
					{#if showActiveSplitDropLayer}
						<!-- svelte-ignore a11y_no_static_element_interactions -- drag target only exists during native drag-and-drop -->
						<div
							class="absolute inset-0 z-40 pointer-events-auto"
							data-split-drag-layer
							ondragover={handleActiveSplitDragOver}
							ondragleave={handleActiveSplitDragLeave}
							ondrop={handleActiveSplitDrop}
							role="region"
							aria-label="Split view drop target"
						>
							<div class={cn(
								'absolute inset-0 pointer-events-none transition-colors duration-150',
								activeSplitDropTarget ? 'bg-background/45 backdrop-blur-[1px]' : 'bg-background/20',
							)}></div>
							{#if activeSplitDropTarget}
								<div
									class="absolute pointer-events-none transition-all duration-150"
									style={getActiveSplitTargetStyle()}
								>
									<div class={cn('absolute border rounded-lg transition-opacity duration-150', getActiveSplitPreviewTone('top'), getActiveSplitPreviewClass('top'), 'inset-x-3 top-3 bottom-[52%]')}>
										<div class="flex h-full items-center justify-center">
											<span class={cn('rounded-md px-2 py-0.5 text-[10px] font-medium shadow-sm', getActiveSplitPreviewLabelClass('top'))}>{getActiveSplitPreviewLabel('top', 'Top')}</span>
										</div>
									</div>
									<div class={cn('absolute border rounded-lg transition-opacity duration-150', getActiveSplitPreviewTone('bottom'), getActiveSplitPreviewClass('bottom'), 'inset-x-3 top-[52%] bottom-3')}>
										<div class="flex h-full items-center justify-center">
											<span class={cn('rounded-md px-2 py-0.5 text-[10px] font-medium shadow-sm', getActiveSplitPreviewLabelClass('bottom'))}>{getActiveSplitPreviewLabel('bottom', 'Bottom')}</span>
										</div>
									</div>
									<div class={cn('absolute border rounded-lg transition-opacity duration-150', getActiveSplitPreviewTone('left'), getActiveSplitPreviewClass('left'), 'inset-y-3 left-3 right-[52%]')}>
										<div class="flex h-full items-center justify-center">
											<span class={cn('rounded-md px-2 py-0.5 text-[10px] font-medium shadow-sm', getActiveSplitPreviewLabelClass('left'))}>{getActiveSplitPreviewLabel('left', 'Left')}</span>
										</div>
									</div>
									<div class={cn('absolute border rounded-lg transition-opacity duration-150', getActiveSplitPreviewTone('right'), getActiveSplitPreviewClass('right'), 'inset-y-3 left-[52%] right-3')}>
										<div class="flex h-full items-center justify-center">
											<span class={cn('rounded-md px-2 py-0.5 text-[10px] font-medium shadow-sm', getActiveSplitPreviewLabelClass('right'))}>{getActiveSplitPreviewLabel('right', 'Right')}</span>
										</div>
									</div>
									<div class={cn('absolute border rounded-lg transition-opacity duration-150', getActiveSplitPreviewTone('center'), getActiveSplitPreviewClass('center'), 'inset-3')}>
										<div class="flex h-full items-center justify-center">
											<span class={cn('rounded-md px-2 py-0.5 text-[10px] font-medium shadow-sm', getActiveSplitPreviewLabelClass('center'))}>Replace</span>
										</div>
									</div>
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
					ondragover={handleWorkspaceDragOver}
					ondragleave={handleWorkspaceDragLeave}
					ondrop={handleWorkspaceDrop}
				>
					<ConversationWorkspace onRegisterSubmit={handleRegisterSubmit} />
					{#if workspaceDragOver}
						<div class="absolute inset-0 z-30 flex items-center justify-center bg-primary/5 border-2 border-dashed border-primary/30 rounded-lg pointer-events-none">
							<span class="text-sm font-medium text-primary bg-primary/10 px-3 py-1.5 rounded-md">Drop to split view</span>
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
	<Dialog.Root open={deleteConfirmation !== null} onOpenChange={(open) => { if (!open) cancelSplitDelete(); }}>
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
				<Button variant="destructive" onclick={() => { void confirmSplitDelete(); }}>{m.sidebar_actions_delete()}</Button>
			</Dialog.Footer>
		</Dialog.Content>
	</Dialog.Root>
</div>
