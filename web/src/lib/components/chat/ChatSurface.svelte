<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import {
		getChatSessions,
		getAppShell,
		getModelCatalog,
		getSplitLayout,
		getChatInteractionGate,
	} from '$lib/context';
	import * as m from '$lib/paraglide/messages.js';
	import ChatEmptyState from '$lib/components/chat/ChatEmptyState.svelte';
	import ChatLoadingState from '$lib/components/chat/ChatLoadingState.svelte';
	import ConversationWorkspace from '$lib/components/chat/ConversationWorkspace.svelte';
	import SplitContainer from '$lib/components/split/SplitContainer.svelte';
	import { SplitPanePreviewStore } from '$lib/chat/split/split-pane-preview-store.svelte.js';
	import { ChatTranscriptCache } from '$lib/chat/transcript/chat-transcript-cache.svelte.js';
	import { INITIAL_VISIBLE_MESSAGES } from '$lib/chat/transcript/active-transcript-state.svelte.js';
	import { getSplitPaneTextScale } from '$lib/chat/split/split-pane-text-scale.js';
	import { canUseForkAction } from '$lib/chat/actions/fork-at-message-action.js';
	import { toggleChatSplitMode } from '$lib/chat/split/chat-split-actions.js';
	import { cn } from '$lib/utils/cn';
	import CurrentChatMenu from '$lib/components/layout/CurrentChatMenu.svelte';
	import type { ChatSessionRecord } from '$lib/types/chat-session';
	import {
		SPLIT_DROP_ZONES,
		SplitDropController,
		type SplitDropZone,
	} from './split-drop-controller.svelte';
	import { resolveChatSurfacePresentation } from './chat-surface-presentation.js';

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

	interface ChatSurfaceProps {
		isMobile: boolean;
		reserveTopFloatingToolbar: boolean;
		isVisible: boolean;
		isInteractive: boolean;
		onMenuClick?: () => void;
		isDesktopFullscreen?: boolean;
		onToggleDesktopFullscreen?: () => void;
		onRegisterReload?: (fn: (chatId: string) => Promise<void>) => void;
		onRegisterSubmit?: (fn: (message: string) => Promise<boolean>) => void;
		chatActions?: WorkspaceChatActions;
	}

	let {
		isMobile,
		reserveTopFloatingToolbar,
		isVisible,
		isInteractive,
		onMenuClick,
		isDesktopFullscreen = false,
		onToggleDesktopFullscreen,
		onRegisterReload,
		onRegisterSubmit,
		chatActions = noopChatActions,
	}: ChatSurfaceProps = $props();

	const sessions = getChatSessions();
	const appShell = getAppShell();
	const modelCatalog = getModelCatalog();
	const splitLayout = getSplitLayout();
	const chatInteractionGate = getChatInteractionGate();
	const chatTranscriptCache = new ChatTranscriptCache({ limit: INITIAL_VISIBLE_MESSAGES });
	const splitPanePreviews = new SplitPanePreviewStore(chatTranscriptCache);

	// Derives selected chat from the canonical session store.
	const selectedChat = $derived(sessions.selectedChat);
	const hasUsableChatContext = $derived(
		Boolean(
			selectedChat &&
			selectedChat.projectIdentityState === 'available' &&
			selectedChat.effectiveProjectKey,
		),
	);
	const chatSurfacePresentation = $derived(
		resolveChatSurfacePresentation(selectedChat, sessions.isLoadingChats),
	);
	const canRenderConversation = $derived(chatSurfacePresentation === 'conversation');
	const showChatLoadingState = $derived(chatSurfacePresentation === 'loading');
	const isMobileLayout = $derived(isMobile);
	const reserveConversationTopFloatingToolbar = $derived(
		reserveTopFloatingToolbar || (isMobileLayout && hasUsableChatContext),
	);
	const canToggleDesktopFullscreen = $derived(!isMobileLayout && !!onToggleDesktopFullscreen);
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
					isProcessing: selectedChat.isProcessing,
				})
			: false,
	);
	const splitDropZones = SPLIT_DROP_ZONES;
	const visibleSplitChatIds = $derived(
		splitLayout.isEnabled ? splitLayout.panes.map((pane) => pane.chatId) : [],
	);
	const splitPaneTextScale = $derived(
		splitLayout.isEnabled ? getSplitPaneTextScale(splitLayout.paneCount) : 1,
	);
	const isSplitWorkspaceActive = $derived(splitLayout.isEnabled && Boolean(splitLayout.root));

	function handleRegisterSubmit(fn: (message: string) => Promise<boolean>): void {
		onRegisterSubmit?.(fn);
	}

	function toggleSplitMode() {
		toggleChatSplitMode(splitLayout, sessions, selectedChat);
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
		if (!hasUsableChatContext || isSplitWorkspaceActive) return;
		splitDrop.handleWorkspaceDragOver(event);
	}

	function handleWorkspaceDragLeave(event: DragEvent): void {
		if (!hasUsableChatContext || isSplitWorkspaceActive) return;
		splitDrop.handleWorkspaceDragLeave(event);
	}

	function handleWorkspaceDrop(event: DragEvent): void {
		if (!hasUsableChatContext || isSplitWorkspaceActive) return;
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
		get isChatDropEligible() {
			return chatInteractionGate.isChatDropEligible;
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
	const unregisterChatInteraction = chatInteractionGate.register({
		cancelApplicationDrag: () => splitDrop.cancelApplicationDrag(),
	});
	const releaseCancelledNativeDrag = () => {
		queueMicrotask(() => splitDrop.releaseNativeDragIgnore());
	};
	const releaseBeforeNewNativeDrag = () => splitDrop.releaseNativeDragIgnore();
	document.addEventListener('dragend', releaseCancelledNativeDrag, true);
	document.addEventListener('drop', releaseCancelledNativeDrag, true);
	document.addEventListener('dragstart', releaseBeforeNewNativeDrag, true);
	onDestroy(() => {
		unregisterChatInteraction();
		document.removeEventListener('dragend', releaseCancelledNativeDrag, true);
		document.removeEventListener('drop', releaseCancelledNativeDrag, true);
		document.removeEventListener('dragstart', releaseBeforeNewNativeDrag, true);
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
		isVisible &&
			isInteractive &&
			canRenderConversation &&
			(!isSplitWorkspaceActive || Boolean(focusedOverlayRect)),
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
			canToggleSplitView
			{isDesktopFullscreen}
			{canToggleDesktopFullscreen}
			canReload
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

<div class="h-full flex flex-col relative" inert={!isInteractive}>
	{#if isMobileLayout && hasUsableChatContext}
		<div data-mobile-current-chat-menu class="absolute right-3 top-3 z-20 sm:hidden">
			{@render currentChatMenu(true)}
		</div>
	{/if}

	<div class="flex-1 min-h-0 overflow-hidden">
		<!-- svelte-ignore a11y_no_static_element_interactions -- split-mode native drop target also owns focused-pane measurement; follow-up: CLEANUP_ROUND_TWO.md#a11y-suppression-register -->
		<div
			class="h-full relative"
			bind:this={splitRootEl}
			inert={!canRenderConversation || !isInteractive}
			aria-hidden={!canRenderConversation || !isVisible}
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
				<!-- Keeps ConversationWorkspace stable while split preview geometry changes. -->
			{/if}
			<div
				data-focused-split-overlay={isSplitWorkspaceActive ? true : undefined}
				data-conversation-workspace-layer
				inert={!canRenderConversation || !isInteractive}
				aria-hidden={!canRenderConversation || !isVisible}
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
					reserveTopFloatingToolbar={reserveConversationTopFloatingToolbar}
					reserveFeedTopFloatingToolbar={reserveTopFloatingToolbar}
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
				<!-- svelte-ignore a11y_no_static_element_interactions -- transient target exists only during native drag-and-drop; follow-up: CLEANUP_ROUND_TWO.md#a11y-suppression-register -->
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
	</div>
	{#if showChatLoadingState}
		<div class="absolute inset-0 z-30 bg-background"><ChatLoadingState /></div>
	{:else if !canRenderConversation}
		<div class="absolute inset-0 z-30 bg-background"><ChatEmptyState /></div>
	{/if}
</div>
