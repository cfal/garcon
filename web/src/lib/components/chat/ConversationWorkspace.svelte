<script lang="ts">
	// Thin composition shell for the chat workspace. Wires extracted
	// controllers (session, scroll, router) and renders the message
	// pane, queue controls, and composer. All business logic lives in
	// the controller modules.

	import { onDestroy, onMount, untrack } from 'svelte';
	import ConversationFeed from './ConversationFeed.svelte';
	import PromptComposer from './PromptComposer.svelte';
	import type { GitQuickBranchSelectorControls } from './git-quick-status-tray-types.js';
	import NewBranchModal from '$lib/components/git/NewBranchModal.svelte';
	import QuickCommitDialog from '$lib/components/git/QuickCommitDialog.svelte';
	import QueueControls from './QueueControls.svelte';
	import SubagentManagementBar from './SubagentManagementBar.svelte';
	import { ChatState, INITIAL_VISIBLE_MESSAGES } from '$lib/chat/state.svelte';
	import type { ChatViewMessage } from '$shared/chat-view';
	import { ChatTranscriptCache } from '$lib/chat/chat-transcript-cache.svelte';
	import { BackgroundTranscriptLoader } from '$lib/chat/background-transcript-loader';
	import type { SplitPanePreviewCursor } from '$lib/chat/split-pane-preview-store.svelte';
	import { ComposerState } from '$lib/chat/composer.svelte';
	import { AgentState } from '$lib/chat/agent-state.svelte';
	import { getChatQueue } from '$lib/api/chats.js';
	import { reloadChatFromNative } from '$lib/chat/reload-chat';
	import { gotoChat } from '$lib/chat/chat-navigation';
	import { StartupCoordinator } from '$lib/chat/startup-coordinator.js';
	import { createDrainCursor } from '$lib/ws/drain';
	import { ChatReconnectCoordinator } from '$lib/ws/reconnect-coordinator.svelte';
	import { mountConversationRouter } from '$lib/chat/conversation-router-adapter.svelte';
	import { selectPreviewFromBatch } from '$lib/events/router.svelte';
	import { ConversationSessionController } from '$lib/chat/conversation-session-controller.svelte';
	import { ConversationScrollController } from '$lib/chat/conversation-scroll-controller.svelte';
	import { ChatLifecycleStore } from '$lib/stores/chat-lifecycle.svelte';
	import { ConversationUiStore } from '$lib/stores/conversation-ui.svelte';
	import { GitQuickSummaryStore } from '$lib/stores/git-quick-summary.svelte';
	import { GitBranchSelectorState } from '$lib/stores/git/git-branch-selector-state.svelte';
	import { QuickCommitDialogState } from '$lib/stores/git/quick-commit-dialog-state.svelte';
	import { gitProjectInvalidations } from '$lib/stores/git-project-invalidation.svelte';
	import { isChatProcessing } from '$lib/chat/chat-processing';
	import { shouldHandleGlobalEscapeAbort } from '$lib/chat/escape-abort-guard';
	import {
		composerCapReservation,
		shouldReserveComposerCapSlot,
	} from '$lib/chat/composer-cap-layout';
	import { buildSubagentManagementModel } from '$lib/chat/subagent-management';
	import {
		getChatSessions,
		getLocalSettings,
		getAppShell,
		getWs,
		getNavigation,
		setChatState,
		setComposerState,
		setAgentState,
		setChatLifecycle,
		getReadReceiptOutbox,
		getModelCatalog,
		getRemoteSettings,
	} from '$lib/context';
	import { ArrowDown, ArrowUp, Loader2 } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import { cn } from '$lib/utils/cn';
	import * as m from '$lib/paraglide/messages.js';

	interface ConversationWorkspaceProps {
		onRegisterSubmit?: (fn: (message: string) => Promise<boolean>) => void;
		onRegisterReload?: (fn: (chatId: string) => Promise<void>) => void;
		transcriptCache?: ChatTranscriptCache;
		reserveTopFloatingToolbar?: boolean;
		getVisibleChatIds?: () => string[];
		isVisiblePreviewChat?: (chatId: string) => boolean;
		getVisiblePreviewCursor?: (chatId: string) => SplitPanePreviewCursor | null;
		applyVisiblePreviewMessages?: (
			chatId: string,
			generationId: string,
			messages: ChatViewMessage[],
			lastSeq?: number,
		) => boolean | void;
		loadVisiblePreviewSnapshot?: (chatId: string) => Promise<void> | void;
		markVisiblePreviewStale?: (chatId: string) => void;
		textScale?: number;
		isVisible?: boolean;
	}

	const fallbackTranscriptCache = new ChatTranscriptCache({ limit: INITIAL_VISIBLE_MESSAGES });

	let {
		onRegisterSubmit,
		onRegisterReload,
		transcriptCache: providedTranscriptCache,
		reserveTopFloatingToolbar = false,
		getVisibleChatIds,
		isVisiblePreviewChat,
		getVisiblePreviewCursor,
		applyVisiblePreviewMessages,
		loadVisiblePreviewSnapshot,
		markVisiblePreviewStale,
		textScale = 1,
		isVisible = true,
	}: ConversationWorkspaceProps = $props();

	function getInitialTranscriptCache(): ChatTranscriptCache {
		return providedTranscriptCache ?? fallbackTranscriptCache;
	}

	const sessions = getChatSessions();
	const localSettings = getLocalSettings();
	const appShell = getAppShell();
	const ws = getWs();
	const navigation = getNavigation();
	const readReceiptOutbox = getReadReceiptOutbox();
	const modelCatalog = getModelCatalog();
	const remoteSettings = getRemoteSettings();

	const transcriptCache = getInitialTranscriptCache();
	const chatState = new ChatState(transcriptCache);
	const backgroundTranscriptLoader = new BackgroundTranscriptLoader({ cache: transcriptCache });
	const composerState = new ComposerState();
	const agentState = new AgentState();
	const lifecycle = new ChatLifecycleStore();
	const conversationUi = new ConversationUiStore();
	const quickGit = new GitQuickSummaryStore();
	const quickGitBranches = new GitBranchSelectorState({
		onMutation: async (projectToRefresh) => {
			gitProjectInvalidations.markChanged(projectToRefresh);
			if (quickGit.projectPath === projectToRefresh) {
				await quickGit.refresh('invalidation');
			}
		},
	});
	const quickCommitDialog = new QuickCommitDialogState({
		refreshSummary: () => quickGit.refresh('dialog-open'),
		markProjectChanged: (projectToMark) => gitProjectInvalidations.markChanged(projectToMark),
	});
	const startupCoordinator = new StartupCoordinator();
	const reconnectCoordinator = new ChatReconnectCoordinator({
		ws,
		chatState,
		conversationUi,
		getSelectedChat: () => sessions.selectedChat,
		getSelectedChatId: () => sessions.selectedChatId,
		getQueue: getChatQueue,
		reconcileProcessing: (activeChatIds) => sessions.reconcileProcessing(activeChatIds),
		quietRefreshChats: () => sessions.quietRefreshChats(),
		getBackgroundCursors: () => transcriptCache.listCursors(20),
		getVisibleChatIds: () => getVisibleChatIds?.() ?? [],
		getVisibleChatCursor: (chatId) => getVisiblePreviewCursor?.(chatId) ?? null,
		loadVisibleChatSnapshot: (chatId) => loadVisiblePreviewSnapshot?.(chatId),
		onVisibleChatMessages: (chatId, generationId, messages, lastSeq) =>
			applyVisiblePreviewMessages?.(chatId, generationId, messages, lastSeq),
		loadBackgroundSnapshot: async (chatId) => {
			if (sessions.selectedChatId === chatId) {
				await chatState.loadMessages(chatId);
				return;
			}
			backgroundTranscriptLoader.queueLoad(chatId);
		},
		onBackgroundMessages: (chatId, generationId, messages, lastSeq) => {
			const applied = transcriptCache.applyMessages(chatId, generationId, messages, lastSeq);
			if (applied.status !== 'applied') return false;
			const preview = selectPreviewFromBatch(messages.map((entry) => entry.message));
			if (preview) sessions.patchPreview(chatId, preview.content, preview.timestamp);
			return true;
		},
	});

	setChatState(chatState);
	setComposerState(composerState);
	setAgentState(agentState);
	setChatLifecycle(lifecycle);

	const activeQueue = $derived.by(() => {
		const chatId = sessions.selectedChatId;
		return conversationUi.getQueue(chatId);
	});
	const scrollToTopButtonClass = $derived(
		cn(
			'absolute right-5 sm:right-6 z-20 w-11 h-11 rounded-full shadow-md hover:shadow-lg',
			reserveTopFloatingToolbar ? 'top-16' : 'top-3',
		),
	);
	const selectedIsProcessing = $derived(isChatProcessing(sessions.selectedChat));
	const projectPath = $derived(sessions.selectedChat?.projectPath || null);
	const quickGitSummaryForProject = $derived(quickGit.summaryFor(projectPath));
	const quickGitBranchErrorForProject = $derived(
		projectPath && quickGitBranches.currentProjectPath === projectPath
			? quickGitBranches.lastError
			: null,
	);
	const quickGitErrorForProject = $derived(
		quickGit.lastErrorFor(projectPath) ?? quickGitBranchErrorForProject,
	);
	const quickGitRefreshingForProject = $derived(quickGit.isRefreshingFor(projectPath));
	const quickGitTrayVisible = $derived(
		!selectedIsProcessing &&
			localSettings.showQuickCommitTray &&
			quickGit.canShowTrayFor(projectPath),
	);
	const reserveComposerTraySpace = $derived(
		shouldReserveComposerCapSlot({
			hasProjectPath: Boolean(projectPath),
			isProcessing: selectedIsProcessing,
		}),
	);
	const queueVisible = $derived((activeQueue?.entries.length ?? 0) > 0);
	// The composer cap floats over whatever sits directly above the composer.
	// Reserve its space on the queue panel when inputs are queued, otherwise on
	// the feed, so the queue's dispatch controls stay clickable behind the cap.
	const composerCapSpace = $derived(composerCapReservation(reserveComposerTraySpace, queueVisible));
	const subagentModel = $derived(
		buildSubagentManagementModel(chatState.displayMessages, {
			rootTitle: sessions.selectedChat?.title || 'Root',
			rootModel: sessions.selectedChat?.model ?? agentState.model,
			rootStatus: selectedIsProcessing ? 'running' : 'idle',
		}),
	);
	const canInterruptSelectedChat = $derived(
		selectedIsProcessing && lifecycle.loadingStatus?.can_interrupt !== false,
	);
	const quickGitBranchSelectorControls = $derived.by<GitQuickBranchSelectorControls | null>(() => {
		if (!projectPath || !quickGitSummaryForProject) return null;
		return {
			refs: quickGitBranches.refs,
			isOpen: quickGitBranches.showBranchDropdown,
			isLoading: quickGitBranches.isLoadingBranches,
			onToggle: toggleQuickGitBranchDropdown,
			onClose: () => quickGitBranches.closeBranchDropdown(),
			onCreateBranch: () => {
				quickGitBranches.showNewBranchModal = true;
				if (projectPath) void quickGitBranches.fetchRefs(projectPath);
			},
			onSwitchBranch: (branch) => switchQuickGitBranch(branch),
			onSearchRefs: (query) => {
				if (!projectPath) return;
				void quickGitBranches.fetchRefs(projectPath, query);
			},
			onSwitchDialogClose: () => appShell.requestComposerFocus(),
		};
	});

	let scrollContainer: HTMLDivElement | null = $state(null);
	let scrollContentContainer: HTMLDivElement | null = $state(null);
	let queueControlsContainer: HTMLDivElement | undefined = $state();

	// WS drain and event router.
	const drainHandle = createDrainCursor(ws);
	onDestroy(() => {
		drainHandle.cleanup();
		quickGit.destroy();
		quickGitBranches.destroy();
		transcriptCache.flush();
	});

	mountConversationRouter({
		ws,
		drainHandle,
		sessions,
		chatState,
		agentState,
		lifecycle,
		conversationUi,
		startupCoordinator,
		readReceiptOutbox,
		transcriptCache,
		backgroundTranscriptLoader,
		visiblePreviews: {
			isVisible: (chatId) => isVisiblePreviewChat?.(chatId) ?? false,
			applyMessages: (chatId, generationId, messages) =>
				applyVisiblePreviewMessages?.(chatId, generationId, messages),
			loadSnapshot: (chatId) => loadVisiblePreviewSnapshot?.(chatId),
			markStale: (chatId) => markVisiblePreviewStale?.(chatId),
		},
	});
	reconnectCoordinator.mount();

	conversationUi.mountQueuePruning({
		getActiveChatIds: () => new Set(Object.keys(sessions.byId)),
	});

	// Scroll controller.
	const scroll = new ConversationScrollController({
		getScrollContainer: () => scrollContainer,
		getScrollContentContainer: () => scrollContentContainer,
		getQueueContainer: () => queueControlsContainer,
		chatState,
		sessions,
	});

	function scrollToBottomAndFill(): void {
		scroll.scrollToBottom();
		void scroll.fillUnderfilledViewport();
	}

	// Session controller.
	const controller = new ConversationSessionController({
		sessions,
		chatState,
		composerState,
		agentState,
		lifecycle,
		conversationUi,
		startupCoordinator,
		modelCatalog,
		appShell,
		readReceiptOutbox,
		navigation: {
			setActiveTab: (tab) => navigation.setActiveTab(tab),
			navigateToChat: (chatId) => {
				sessions.setSelectedChatId(chatId);
				void gotoChat(chatId).finally(() => appShell.requestComposerFocus());
			},
		},
		reloadTranscript: (chatId) => reloadChatFromNative(ws, chatState, chatId),
		setIsViewportPinnedToBottom: (v) => {
			scroll.setPinnedToBottom(v);
		},
		setInitialBottomRestorePending: (chatId) => scroll.prepareInitialBottomRestore(chatId),
		scrollToBottom: scrollToBottomAndFill,
	});

	// Expose the submit function to sibling components (runs once on mount).
	onMount(() => {
		onRegisterSubmit?.(submitToActiveChat);
		onRegisterReload?.(reloadSelectedChat);
	});

	// Chat switch effect (dedup handled inside the controller).
	$effect(() => {
		controller.handleChatSwitchIfChanged(sessions.selectedChatId);
	});

	$effect(() => {
		const currentProjectPath = projectPath;
		const currentBranch = quickGitSummaryForProject?.branch;
		quickGitBranches.setProject(currentProjectPath, currentBranch);
	});

	$effect(() => {
		const currentProjectPath = projectPath;
		const enabled = localSettings.showQuickCommitTray;
		const processing = selectedIsProcessing;
		quickGit.setProject(currentProjectPath);
		quickGit.setEnabled(enabled);
		quickGit.setProcessing(processing);
		return untrack(() => quickGit.startPolling());
	});

	let lastQuickGitInvalidationKey = '';
	$effect(() => {
		const currentProjectPath = projectPath;
		const version = gitProjectInvalidations.version(currentProjectPath);
		if (!currentProjectPath) return;
		const key = `${currentProjectPath}:${version}`;
		if (key === lastQuickGitInvalidationKey) return;
		lastQuickGitInvalidationKey = key;
		if (version === 0) return;
		untrack(() => quickGit.scheduleRefresh('invalidation', 100));
	});

	const isPreparingInitialScroll = $derived(
		scroll.isPreparingInitialScroll && localSettings.autoScrollToBottom,
	);

	// Scrolls to bottom when the bottom row changes, including same-count replacements.
	$effect(() => {
		const _isVisible = isVisible;
		const _bottomRowId = chatState.bottomVisibleRowId;
		const _reserveComposerTraySpace = reserveComposerTraySpace;
		if (_isVisible && !chatState.isUserScrolledUp && localSettings.autoScrollToBottom) {
			scrollToBottomAndFill();
			scroll.completeInitialBottomRestore();
		}
	});

	$effect(() => {
		const _chatId = sessions.selectedChatId;
		const _loadStatus = chatState.loadStatus;
		const _displayMessageCount = chatState.displayMessageCount;
		const _autoScroll = localSettings.autoScrollToBottom;
		scroll.reconcileInitialBottomRestore(_autoScroll);
	});

	// Restores bottom pinning when the Chat tab becomes visible again.
	$effect(() => {
		scroll.setViewportVisible(isVisible);
	});

	// Marks real scroll gestures on the actual viewport element. This avoids
	// depending on wrapper component event forwarding for wheel and touch input.
	$effect(() => {
		const node = scrollContainer;
		if (!node) return;

		const noteIntent = () => scroll.noteUserScrollIntent();
		const handleKeydown = (event: KeyboardEvent) => {
			if (
				event.key === 'ArrowUp' ||
				event.key === 'ArrowDown' ||
				event.key === 'PageUp' ||
				event.key === 'PageDown' ||
				event.key === 'Home' ||
				event.key === 'End' ||
				event.key === ' '
			) {
				scroll.noteUserScrollIntent();
			}
		};

		node.addEventListener('wheel', noteIntent, { capture: true, passive: true });
		node.addEventListener('touchstart', noteIntent, { capture: true, passive: true });
		node.addEventListener('keydown', handleKeydown, { capture: true });

		return () => {
			node.removeEventListener('wheel', noteIntent, { capture: true });
			node.removeEventListener('touchstart', noteIntent, { capture: true });
			node.removeEventListener('keydown', handleKeydown, { capture: true });
		};
	});

	// Scrolls to bottom when the scroll container becomes available.
	// The bind:this resolves after initial render, so earlier scrollToBottom
	// calls from loadChat fire against an undefined container.
	$effect(() => {
		const _container = scrollContainer;
		const _isVisible = isVisible;
		untrack(() => {
			if (
				_isVisible &&
				_container &&
				chatState.displayMessageCount > 0 &&
				localSettings.autoScrollToBottom
			) {
				scrollToBottomAndFill();
			}
		});
	});

	// Preserves viewport anchoring when queue controls change height.
	$effect(() => {
		const _host = queueControlsContainer;
		const _scroller = scrollContainer;
		const _selected = sessions.selectedChatId;
		return scroll.observeQueueResize();
	});

	// Keeps bottom-pinned chats pinned when the message viewport height changes.
	$effect(() => {
		const _scroller = scrollContainer;
		const _selected = sessions.selectedChatId;
		return scroll.observeScrollContainerResize();
	});

	// Content height can settle after messages mount, especially code and
	// markdown blocks. Keeps bottom-pinned chats pinned through that settling.
	$effect(() => {
		const _content = scrollContentContainer;
		const _scroller = scrollContainer;
		return scroll.observeScrollContentResize();
	});

	function handleGlobalKeydown(event: KeyboardEvent) {
		if (shouldHandleGlobalEscapeAbort(event) && canInterruptSelectedChat) {
			event.preventDefault();
			controller.handleAbort();
		}
		scroll.handleHalfPageScroll(event);
	}

	function onSubmit(text?: string, images?: File[]) {
		const chatId = sessions.selectedChatId;
		if (!chatId) return;
		void controller.submitForChat(chatId, text, images);
	}

		function jumpToToolInput(anchorId: string): void {
			document.getElementById(anchorId)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
		}

		async function generateTitleFromMessage(message: string, messageSeq?: number): Promise<void> {
			const chatId = sessions.selectedChatId;
			if (!chatId) return;
			await sessions.generateChatTitleFromMessage(chatId, message, messageSeq);
		}

		// Exposes a chat submit function for sibling components (e.g. git review).
		async function submitToActiveChat(message: string): Promise<boolean> {
		const chatId = sessions.selectedChatId;
		if (!chatId) return false;
		try {
			await controller.submitForChat(chatId, message);
			return true;
		} catch {
			return false;
		}
	}

	async function reloadSelectedChat(chatId: string): Promise<void> {
		if (!chatId || chatId !== sessions.selectedChatId) {
			throw new Error(m.sidebar_chats_reload_failed());
		}
		await reloadChatFromNative(ws, chatState, chatId);
	}

	async function openQuickCommitDialog(): Promise<void> {
		if (!projectPath || !quickGitSummaryForProject) return;
		await quickCommitDialog.open(projectPath);
	}

	function toggleQuickGitBranchDropdown(): void {
		if (!projectPath) return;
		if (quickGitBranches.showBranchDropdown) {
			quickGitBranches.closeBranchDropdown();
			return;
		}
		void quickGitBranches.openBranchDropdown(projectPath);
	}

	async function switchQuickGitBranch(branch: string): Promise<void> {
		if (!projectPath) return;
		await quickGitBranches.switchBranch(projectPath, branch);
	}

	async function createQuickGitBranch(): Promise<void> {
		if (!projectPath) return;
		await quickGitBranches.createBranch(projectPath);
	}
</script>

<svelte:window onkeydown={handleGlobalKeydown} />

{#if !projectPath}
	<div class="flex items-center justify-center h-full">
		<div class="text-center text-muted-foreground">
			<p>{m.chat_workspace_select_project()}</p>
		</div>
	</div>
{:else}
	<div class="h-full flex flex-col">
		<SubagentManagementBar model={subagentModel} onJumpToTool={jumpToToolInput} />

		<div class="relative flex-1 min-h-0">
			<ConversationFeed
				bind:scrollContainer
				bind:scrollContentContainer
				onscroll={() => scroll.handleScroll()}
				onUserScrollIntent={() => scroll.noteUserScrollIntent()}
				onPermissionDecision={(id, d) => controller.handlePermissionDecision(id, d)}
				onExitPlanMode={(id, c, p) => controller.handleExitPlanMode(id, c, p)}
				pendingPermissionRequests={conversationUi.pendingPermissionRequests}
				onRetry={() => {
					const chatId = sessions.selectedChatId;
					if (chatId) controller.loadChat(chatId);
				}}
					onForkChat={(upToSeq) => {
						const chatId = sessions.selectedChatId;
						if (chatId) void controller.forkChat(chatId, upToSeq);
					}}
					onGenerateTitleFromMessage={generateTitleFromMessage}
					reserveComposerTraySpace={composerCapSpace.feed}
					{isPreparingInitialScroll}
					isProcessing={selectedIsProcessing}
				{textScale}
			/>

			{#if chatState.isUserScrolledUp && chatState.displayMessageCount > 0}
				<Button
					variant="outline"
					size="icon"
					class={scrollToTopButtonClass}
					onclick={() => scroll.scrollToTop()}
					disabled={scroll.isScrollingToTop}
					title={m.workspace_scroll_to_initial_prompt()}
				>
					{#if scroll.isScrollingToTop}
						<Loader2 class="w-5 h-5 animate-spin" />
					{:else}
						<ArrowUp class="w-5 h-5" />
					{/if}
				</Button>
				<Button
					variant="outline"
					size="icon"
					class="absolute bottom-14 right-5 sm:right-6 z-20 w-11 h-11 rounded-full shadow-md hover:shadow-lg"
					onclick={() => scroll.scrollToBottom()}
					title={m.workspace_scroll_to_bottom()}
				>
					<ArrowDown class="w-5 h-5" />
				</Button>
			{/if}
		</div>

		<div bind:this={queueControlsContainer} class={cn(composerCapSpace.queue && 'pb-14')}>
			<QueueControls
				queue={activeQueue}
				onResume={() => controller.handleQueueResume()}
				onPause={() => controller.handleQueuePause()}
				onDequeue={(id) => controller.handleDequeue(id)}
			/>
		</div>

		<PromptComposer
			{isVisible}
			onsubmit={onSubmit}
			onModelChange={(next) => controller.handleModelSelectionChange(next)}
			onPermissionModeChange={(m) => controller.handlePermissionModeChange(m)}
			onThinkingModeChange={(m) => controller.handleThinkingModeChange(m)}
			onAbort={() => controller.handleAbort()}
			quickCommitTrayVisible={quickGitTrayVisible}
			quickCommitSummary={quickGitSummaryForProject}
			quickCommitRefreshing={quickGitRefreshingForProject}
			quickCommitError={quickGitErrorForProject}
			quickCommitBranchSelector={quickGitBranchSelectorControls}
			onQuickCommit={openQuickCommitDialog}
		/>
		<QuickCommitDialog
			dialog={quickCommitDialog}
			isMobile={appShell.isMobile}
			onClosed={() => appShell.requestComposerFocus()}
		/>
		{#if quickGitBranches.showNewBranchModal}
			<NewBranchModal
				currentBranch={quickGitSummaryForProject?.branch ||
					quickGitBranches.currentBranch ||
					'HEAD'}
				newBranchName={quickGitBranches.newBranchName}
				refOptions={quickGitBranches.refs}
				selectedBaseRef={quickGitBranches.newBranchBaseRef}
				isLoadingRefs={quickGitBranches.isLoadingBranches}
				isCreatingBranch={quickGitBranches.isCreatingBranch}
				onNameChange={(name) => (quickGitBranches.newBranchName = name)}
				onBaseRefChange={(ref) => (quickGitBranches.newBranchBaseRef = ref)}
				onSearchRefs={(query) => {
					if (!projectPath) return;
					void quickGitBranches.fetchRefs(projectPath, query);
				}}
				onCreateBranch={createQuickGitBranch}
				onClose={() => (quickGitBranches.showNewBranchModal = false)}
			/>
		{/if}
	</div>
{/if}
