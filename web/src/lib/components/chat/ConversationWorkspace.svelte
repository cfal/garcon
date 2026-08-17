<script lang="ts">
	// Thin composition shell for the chat workspace. Wires extracted
	// controllers (session, scroll, router) and renders the message
	// pane, queue controls, and composer. All business logic lives in
	// the controller modules.

	import { onDestroy, onMount, untrack } from 'svelte';
	import ConversationFeed from './ConversationFeed.svelte';
	import MessageRenderFallback from './MessageRenderFallback.svelte';
	import PromptComposer from './PromptComposer.svelte';
	import QueuedInputsDialog from './QueuedInputsDialog.svelte';
	import HandoffForkDialog from './HandoffForkDialog.svelte';
	import ReloadChatDialog from './ReloadChatDialog.svelte';
	import UserMessageNavigatorDialog from './UserMessageNavigatorDialog.svelte';
	import type { GitQuickBranchSelectorControls } from './git-quick-status-tray-types.js';
	import QueueControls from './QueueControls.svelte';
	import {
		ActiveTranscriptState,
		INITIAL_VISIBLE_MESSAGES,
	} from '$lib/chat/transcript/active-transcript-state.svelte.js';
	import type { ResendCandidate, TranscriptMessage } from '$shared/chat-view';
	import type { ChatProcessingPhase } from '$shared/chat-types';
	import { searchResultNavigation } from '$lib/chat/actions/search-result-navigation.svelte.js';
	import { ChatTranscriptCache } from '$lib/chat/transcript/chat-transcript-cache.svelte.js';
	import { BackgroundTranscriptLoader } from '$lib/chat/transcript/background-transcript-loader.js';
	import type { SplitPanePreviewCursor } from '$lib/chat/split/split-pane-preview-store.svelte.js';
	import { ComposerState } from '$lib/chat/composer/composer.svelte.js';
	import type { ChatDraftAppend } from '$lib/chat/composer/chat-draft-append.js';
	import type { SubagentToolbarState } from '$lib/chat/transcript/subagent-toolbar-state.svelte.js';
	import { AgentState } from '$lib/chat/conversation/agent-state.svelte.js';
	import { reloadChatFromNative } from '$lib/chat/conversation/reload-chat.js';
	import { gotoChat } from '$lib/chat/actions/chat-navigation.js';
	import { StartupCoordinator } from '$lib/chat/conversation/startup-coordinator.js';
	import { createDrainCursor } from '$lib/ws/drain';
	import { ChatReconnectCoordinator } from '$lib/ws/reconnect-coordinator.svelte';
	import { mountConversationRouter } from '$lib/chat/conversation/conversation-router-adapter.svelte.js';
	import { selectPreviewFromBatch } from '$lib/events/router.svelte';
	import { ConversationSessionController } from '$lib/chat/conversation/conversation-session-controller.svelte.js';
	import { ConversationScrollController } from '$lib/chat/transcript/conversation-scroll-controller.svelte.js';
	import { observeConversationViewportScrollGestures } from '$lib/chat/transcript/conversation-scroll-gesture.js';
	import type { ConversationViewportPort } from '$lib/chat/transcript/conversation-viewport-port.js';
	import {
		UserMessageNavigatorController,
		type UserMessageNavigatorRegistration,
	} from '$lib/chat/transcript/user-message-navigator-controller.svelte.js';
	import { ConversationLifecycleState } from '$lib/chat/conversation/conversation-lifecycle-state.svelte.js';
	import { ConversationUiState } from '$lib/chat/conversation/conversation-ui-state.svelte.js';
	import { isAcceptedConversationSubmission } from '$lib/chat/conversation/conversation-submission-outcome.js';
	import { QueuedInputEditorState } from '$lib/chat/conversation/queued-input-editor-state.svelte.js';
	import type { QueueEntry } from '$lib/types/chat';
	import type { SessionAgentId } from '$lib/types/app';
	import {
		CHAT_DOCK_SHELL_BASE_CLASS,
		CHAT_MAX_WIDTH_DOCK_FRAME_CLASS,
		CHAT_MAX_WIDTH_DOCK_SHELL_CLASS,
	} from '$lib/chat/conversation/chat-max-width.js';
	import { isChatProcessing } from '$lib/chat/sessions/chat-processing.js';
	import { CHAT_SURFACE_ID } from '$lib/workspace/surface-types.js';
	import { registerManagedWorkspaceScrollRegion } from '$lib/workspace/workspace-scroll-region.js';
	import {
		composerCapReservation,
		shouldReserveComposerCapSlot,
	} from '$lib/chat/composer/composer-cap-layout.js';
	import { buildSubagentManagementModel } from '$lib/chat/transcript/subagent-management.js';
	import {
		getChatSessions,
		getLocalSettings,
		getAppShell,
		getWs,
		setActiveTranscriptState,
		setComposerState,
		setAgentState,
		setConversationLifecycle,
		getReadReceiptOutbox,
		getModelCatalog,
		getRemoteSettings,
		getWorkspaceCoordinator,
		getWorkspaceShortcuts,
		getGitQuickSummary,
		getGitBranchActions,
		getChatProcessingReconciler,
	} from '$lib/context';
	import ArrowDown from '@lucide/svelte/icons/arrow-down';
	import ArrowUp from '@lucide/svelte/icons/arrow-up';
	import Loader2 from '@lucide/svelte/icons/loader-2';
	import { Button } from '$lib/components/ui/button';
	import { cn } from '$lib/utils/cn';
	import * as m from '$lib/paraglide/messages.js';
	import {
		executionDefaultsForAgent,
		normalizeSupportedPermissionMode,
		normalizeSupportedThinkingMode,
	} from '$shared/execution-defaults';

	interface ConversationWorkspaceProps {
		onRegisterSubmit?: (fn: (message: string) => Promise<boolean>) => void;
		onRegisterAppendToDraft?: (fn: ChatDraftAppend) => void;
		onRegisterReload?: (fn: (chatId: string) => Promise<void>) => void;
		onRegisterUserMessageNavigator?: (command: UserMessageNavigatorRegistration) => void;
		onRegisterPrepareHide?: (prepare: (() => void) | null) => void;
		subagentToolbar: SubagentToolbarState;
		transcriptCache?: ChatTranscriptCache;
		reserveTopFloatingToolbar?: boolean;
		reserveFeedTopFloatingToolbar?: boolean;
		getVisibleChatIds?: () => string[];
		isVisiblePreviewChat?: (chatId: string) => boolean;
		getVisiblePreviewCursor?: (chatId: string) => SplitPanePreviewCursor | null;
		applyVisiblePreviewMessages?: (
			chatId: string,
			transcriptViewId: string,
			messages: TranscriptMessage[],
			firstOrdinal: number,
			lastOrdinal: number,
		) => boolean | void;
		loadVisiblePreviewSnapshot?: (chatId: string) => Promise<void> | void;
		markVisiblePreviewStale?: (chatId: string) => void;
		textScale?: number;
		isVisible?: boolean;
		isPresented?: boolean;
	}

	type ReloadRequest = {
		readonly chatId: string;
		readonly candidates: readonly ResendCandidate[];
		readonly complete: () => void;
		readonly fail: (error: unknown) => void;
	};

	const fallbackTranscriptCache = new ChatTranscriptCache({ limit: INITIAL_VISIBLE_MESSAGES });

	let {
		onRegisterSubmit,
		onRegisterAppendToDraft,
		onRegisterReload,
		onRegisterUserMessageNavigator,
		onRegisterPrepareHide,
		subagentToolbar,
		transcriptCache: providedTranscriptCache,
		reserveTopFloatingToolbar = false,
		reserveFeedTopFloatingToolbar = false,
		getVisibleChatIds,
		isVisiblePreviewChat,
		getVisiblePreviewCursor,
		applyVisiblePreviewMessages,
		loadVisiblePreviewSnapshot,
		markVisiblePreviewStale,
		textScale = 1,
		isVisible = true,
		isPresented: isPresentedOverride,
	}: ConversationWorkspaceProps = $props();
	const isPresented = $derived(isPresentedOverride ?? isVisible);

	function getInitialTranscriptCache(): ChatTranscriptCache {
		return providedTranscriptCache ?? fallbackTranscriptCache;
	}

	const sessions = getChatSessions();
	const localSettings = getLocalSettings();
	const appShell = getAppShell();
	const ws = getWs();
	const readReceiptOutbox = getReadReceiptOutbox();
	const modelCatalog = getModelCatalog();
	const remoteSettings = getRemoteSettings();
	const workspace = getWorkspaceCoordinator();
	const workspaceShortcuts = getWorkspaceShortcuts();

	const transcriptCache = getInitialTranscriptCache();
	const chatState = new ActiveTranscriptState(transcriptCache);
	const backgroundTranscriptLoader = new BackgroundTranscriptLoader({ cache: transcriptCache });
	const composerState = new ComposerState();
	const agentState = new AgentState();
	const lifecycle = new ConversationLifecycleState();
	const conversationUi = new ConversationUiState();
	const processingReconciler = getChatProcessingReconciler();
	const removeProcessingPresentation = processingReconciler.addPresentation({
		get currentChatId() {
			return lifecycle.currentChatId;
		},
		applyProcessingPhase: (chatId, phase) => {
			lifecycle.applyProcessingPhase(chatId, phase);
		},
		applyProcessingSnapshotPhase: (chatId, phase, sentAt) => {
			lifecycle.applyProcessingSnapshotPhase(chatId, phase, sentAt);
		},
		clearTurnPermissionRequests: () => conversationUi.clearTurnPermissionRequests(),
	});

	let queuedInputsDialogOpen = $state(false);
	let queuedInputsDialogChatId = $state<string | null>(null);
	let composerEditorOpenRequestId = $state(0);
	let reloadRequest = $state.raw<ReloadRequest | null>(null);
	let reloadInProgress = $state(false);
	const dialogControl = $derived(conversationUi.getExecutionControl(queuedInputsDialogChatId));
	const dialogQueue = $derived(dialogControl?.queue ?? null);
	const queuedInputEditor = new QueuedInputEditorState({
		get queue() {
			return dialogQueue;
		},
	});
	const quickGit = getGitQuickSummary();
	const quickGitBranches = getGitBranchActions();
	const startupCoordinator = new StartupCoordinator();
	const reconnectCoordinator = new ChatReconnectCoordinator({
		ws,
		chatState,
		conversationUi,
		sessions,
		getBackgroundCursors: () => transcriptCache.listCursors(20),
		getVisibleChatIds: () => getVisibleChatIds?.() ?? [],
		getVisibleChatCursor: (chatId) => getVisiblePreviewCursor?.(chatId) ?? null,
		loadVisibleChatSnapshot: (chatId) => loadVisiblePreviewSnapshot?.(chatId),
		onVisibleChatMessages: (chatId, transcriptViewId, messages, firstOrdinal, lastOrdinal) =>
			applyVisiblePreviewMessages?.(
				chatId,
				transcriptViewId,
				messages,
				firstOrdinal,
				lastOrdinal,
			),
		markBackgroundStale: (chatId) => transcriptCache.markStale(chatId),
		onBackgroundMessages: (chatId, transcriptViewId, messages, firstOrdinal, lastOrdinal) => {
			const applied = transcriptCache.applyMessages(chatId, transcriptViewId, {
				messages,
				firstOrdinal,
				lastOrdinal,
			});
			if (applied.status !== 'applied') return false;
			const preview = selectPreviewFromBatch(messages.map((entry) => entry.message));
			if (preview) sessions.patchPreview(chatId, preview.content, preview.timestamp);
			return true;
		},
	});

	setActiveTranscriptState(chatState);
	setComposerState(composerState);
	setAgentState(agentState);
	setConversationLifecycle(lifecycle);

	const activeControl = $derived.by(() => {
		const chatId = sessions.selectedChatId;
		return conversationUi.getExecutionControl(chatId);
	});
	const activeQueue = $derived(activeControl?.queue ?? null);
	const scrollToTopButtonClass = $derived(
		cn(
			'absolute right-5 sm:right-6 z-20 w-11 h-11 rounded-full shadow-md hover:shadow-lg',
			reserveTopFloatingToolbar ? 'top-16' : 'top-3',
		),
	);
	const selectedIsProcessing = $derived(isChatProcessing(sessions.selectedChat));
	const projectPath = $derived(sessions.selectedChat?.projectPath || null);
	const effectiveProjectKey = $derived(sessions.selectedChat?.effectiveProjectKey ?? null);
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
	const queueShellClass = $derived.by(() => {
		if (!queueVisible) return '';
		return cn(
			CHAT_DOCK_SHELL_BASE_CLASS,
			CHAT_MAX_WIDTH_DOCK_SHELL_CLASS[localSettings.chatMaxWidth],
			composerCapSpace.queue ? 'pb-14' : 'pb-2',
		);
	});
	const queueFrameClass = $derived(
		cn('w-full', CHAT_MAX_WIDTH_DOCK_FRAME_CLASS[localSettings.chatMaxWidth]),
	);
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
	const selectedAgentId = $derived(
		(sessions.selectedChat?.agentId ?? agentState.agentId) as SessionAgentId,
	);
	const canSteerSelectedChat = $derived(
		selectedIsProcessing && modelCatalog.supportsSteering(selectedAgentId),
	);
	const quickGitBranchSelectorControls = $derived.by<GitQuickBranchSelectorControls | null>(() => {
		if (!projectPath || !quickGitSummaryForProject) return null;
		return {
			refs: quickGitBranches.refs,
			isOpen: quickGitBranches.showBranchDropdown,
			isLoading: quickGitBranches.isLoadingBranches,
			onToggle: toggleCommitBranchDropdown,
			onClose: () => quickGitBranches.closeBranchDropdown(),
			onCreateBranch: () => {
				if (projectPath && effectiveProjectKey) {
					quickGitBranches.openNewBranchDialog(projectPath, CHAT_SURFACE_ID, effectiveProjectKey);
				}
			},
			onSwitchBranch: (branch) => switchCommitBranch(branch),
			onSearchRefs: (query) => {
				if (!projectPath) return;
				void quickGitBranches.fetchRefs(projectPath, query);
			},
			onSwitchDialogClose: () => appShell.requestComposerFocus(),
		};
	});

	let scrollContainer: HTMLDivElement | null = $state(null);
	let initializedScrollContainer = false;
	let conversationViewport: ConversationViewportPort | null = $state(null);
	let queueControlsContainer: HTMLDivElement | undefined = $state();
	const conversationSurfaceIdentity = $derived(
		`${chatState.activeChatId ?? 'none'}:${chatState.transcriptViewId}`,
	);

	// WS drain and event router.
	const drainHandle = createDrainCursor(ws);
	onDestroy(() => {
		reloadRequest?.complete();
		reloadRequest = null;
		removeProcessingPresentation();
		drainHandle.cleanup();
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
			applyMessages: (chatId, transcriptViewId, messages, firstOrdinal, lastOrdinal) =>
				applyVisiblePreviewMessages?.(
					chatId,
					transcriptViewId,
					messages,
					firstOrdinal,
					lastOrdinal,
				),
			loadSnapshot: (chatId) => loadVisiblePreviewSnapshot?.(chatId),
			markStale: (chatId) => markVisiblePreviewStale?.(chatId),
		},
	});
	reconnectCoordinator.mount();

	conversationUi.mountExecutionControlPruning({
		getActiveChatIds: () => new Set(Object.keys(sessions.byId)),
	});

	// Scroll controller.
	const scroll = new ConversationScrollController({
		getScrollContainer: () => scrollContainer,
		getViewport: () => conversationViewport,
		getQueueContainer: () => queueControlsContainer,
		chatState,
		sessions,
	});
	function scrollToBottomAndFill(): void {
		void scroll.scrollToLatestAndFill();
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
		getExecutionDefaults: (agentId) => {
			const defaults = executionDefaultsForAgent(
				remoteSettings.snapshot?.executionDefaults,
				agentId,
			);
			return {
				permissionMode: normalizeSupportedPermissionMode(
					defaults.permissionMode,
					modelCatalog.getPermissionModes(agentId),
				),
				thinkingMode: normalizeSupportedThinkingMode(
					defaults.thinkingMode,
					modelCatalog.getThinkingModes(agentId),
				),
					agentSettings: defaults.agentSettingsById[agentId]
						?? modelCatalog.getDefaultAgentSettings(agentId),
			};
		},
		appShell,
		readReceiptOutbox,
		navigation: {
			navigateToChat: (chatId) => {
				sessions.setSelectedChatId(chatId);
				void gotoChat(chatId).finally(() => appShell.requestComposerFocus());
			},
		},
		requestProcessingSnapshot: (source) => ws.requestProcessingSnapshot(source),
		setIsViewportPinnedToBottom: (v) => {
			scroll.setPinnedToBottom(v);
		},
		setInitialBottomRestorePending: (chatId) => scroll.prepareInitialBottomRestore(chatId),
		scrollToBottom: scrollToBottomAndFill,
	});
	const directAdmissionPending = $derived(
		controller.isDirectAdmissionPending(sessions.selectedChatId),
	);
	// Consumes an epoch-validated search navigation exactly once, after the
	// selected chat's transcript has the target row loaded.
	$effect(() => {
		const chatId = chatState.activeChatId;
		if (!chatId || chatState.loadStatus !== 'loaded') return;
		if (!searchResultNavigation.peek(chatId)) return;
		if (chatState.transcriptViewId === '') return;
		const ordinal = searchResultNavigation.take(chatId);
		if (ordinal === null || ordinal > chatState.lastOrdinal) return;
		void scroll.jumpToMessageRow({
			chatId,
			transcriptViewId: chatState.transcriptViewId,
			rowId: `${chatState.transcriptViewId}:${ordinal}`,
		});
	});

	const userMessageNavigator = new UserMessageNavigatorController({
		transcript: chatState,
		getSelectedChatId: () => sessions.selectedChatId,
		reloadTranscript: (chatId) => controller.loadChat(chatId),
		restoreLatestTranscript: (chatId) => scroll.restoreLatestWindow(chatId),
		loadOlderMessages: (chatId) => scroll.loadEarlierPageForNavigator(chatId),
		jumpToRow: (target) => scroll.jumpToMessageRow(target),
	});

	// Expose the submit function to sibling components (runs once on mount).
	onMount(() => {
		onRegisterSubmit?.(submitToActiveChat);
		onRegisterAppendToDraft?.(appendToActiveDraft);
		onRegisterReload?.(reloadSelectedChat);
		onRegisterUserMessageNavigator?.(() => void userMessageNavigator.openForActiveChat());
		const unregisterSubagentToolbar = subagentToolbar.register({
			get model() {
				return subagentModel;
			},
			jumpToTool: jumpToToolInput,
		});

		return () => {
			unregisterSubagentToolbar();
			onRegisterUserMessageNavigator?.(null);
		};
	});

	// Chat switch effect (dedup handled inside the controller).
	$effect(() => {
		const chatId = sessions.selectedChatId;
		// The selected record may hydrate after the route-selected ID.
		const _selectedChat = sessions.selectedChat;
		if (queuedInputsDialogOpen && queuedInputsDialogChatId !== chatId) {
			closeQueuedInputsDialog();
		}
		if (reloadRequest && reloadRequest.chatId !== chatId) cancelReload();
		controller.handleChatSwitchIfChanged(chatId);
	});

	$effect(() => {
		const chatId = sessions.selectedChatId;
		const transcriptViewId = chatState.transcriptViewId;
		userMessageNavigator.reconcileActiveTranscript(chatId, transcriptViewId);
	});

	const isPreparingInitialScroll = $derived(
		scroll.isPreparingInitialScroll && localSettings.autoScrollToBottom,
	);

	$effect(() => {
		const _chatId = sessions.selectedChatId;
		const _loadStatus = chatState.loadStatus;
		const _displayMessageCount = chatState.displayMessageCount;
		const _feedDataRevision = chatState.feedMutationClock.dataRevision;
		const _viewport = conversationViewport;
		const _autoScroll = localSettings.autoScrollToBottom;
		scroll.reconcilePinnedProjection();
		scroll.reconcileInitialBottomRestore(_autoScroll);
	});

	// Restores bottom pinning when the Chat tab becomes visible again.
	$effect(() => {
		scroll.setViewportVisible(isVisible);
	});

	// Marks real scroll gestures on the actual viewport element without wrapper event forwarding.
	$effect(() => {
		const node = scrollContainer;
		if (!node) return;
		return observeConversationViewportScrollGestures(node, (direction) =>
			scroll.noteUserScrollIntent(direction),
		);
	});

	// Scrolls to bottom when the scroll container becomes available.
	// The bind:this resolves after initial render, so earlier scrollToBottom
	// calls from loadChat fire against an undefined container.
	$effect(() => {
		const _container = scrollContainer;
		if (!_container) return;
		untrack(() => {
			if (initializedScrollContainer) return;
			initializedScrollContainer = true;
			if (isVisible && chatState.displayMessageCount > 0 && localSettings.autoScrollToBottom) {
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

	$effect(() => {
		const region = scrollContainer;
		if (!region) return;
		return registerManagedWorkspaceScrollRegion(region, 'primary', (_element, direction) =>
			scroll.scrollFeedHalfPage(direction),
		);
	});

	function handleWorkspaceShortcut(event: KeyboardEvent): boolean {
		if (!isPresented) return false;
		const targetsPresentedComposerEditor =
			event.target instanceof Element &&
			Boolean(event.target.closest('[data-composer-editor-dialog]'));
		if (
			(isVisible || targetsPresentedComposerEditor) &&
			!event.repeat &&
			!event.isComposing &&
			sessions.selectedChatId &&
			workspaceShortcuts.matchesGlobalShortcut('open-composer-editor', event)
		) {
			event.preventDefault();
			composerEditorOpenRequestId += 1;
			return true;
		}
		if (!isVisible) return false;
		if (
			event.key === 'Escape' &&
			!event.repeat &&
			!event.defaultPrevented &&
			canInterruptSelectedChat
		) {
			event.preventDefault();
			controller.handleAbort();
			return true;
		}
		return false;
	}

	$effect(() => workspaceShortcuts.registerSurface(CHAT_SURFACE_ID, handleWorkspaceShortcut));

	function onSubmit(text?: string, images?: File[]) {
		const chatId = sessions.selectedChatId;
		if (!chatId) return;
		void controller.submitForChat(chatId, text, images);
	}

	function onSteerPreferredSubmit(): void {
		const chatId = sessions.selectedChatId;
		if (!chatId) return;
		void controller.submitComposerWithSteerPreference(chatId);
	}

	function openQueuedInputsManager(): void {
		const chatId = sessions.selectedChatId;
		if (!chatId) return;
		queuedInputEditor.close();
		queuedInputsDialogChatId = chatId;
		queuedInputsDialogOpen = true;
	}

	function editQueuedInput(entry: QueueEntry): void {
		const chatId = sessions.selectedChatId;
		if (!chatId) return;
		queuedInputsDialogChatId = chatId;
		queuedInputEditor.begin(entry);
		queuedInputsDialogOpen = true;
	}

	function closeQueuedInputsDialog(): void {
		queuedInputsDialogOpen = false;
		queuedInputsDialogChatId = null;
		queuedInputEditor.close();
	}

	function jumpToToolInput(anchorId: string): void {
		void scroll.jumpToDomAnchor(anchorId);
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
			return isAcceptedConversationSubmission(await controller.submitForChat(chatId, message));
		} catch {
			return false;
		}
	}

	function appendToActiveDraft(block: string) {
		return composerState.appendDraftBlock(sessions.selectedChatId ?? '', block);
	}

	async function reloadSelectedChat(chatId: string): Promise<void> {
		if (!chatId || chatId !== sessions.selectedChatId) {
			throw new Error(m.sidebar_chats_reload_failed());
		}
		if (reloadRequest) throw new Error(m.sidebar_chats_reload_failed());
		return new Promise<void>((resolve, reject) => {
			reloadRequest = {
				chatId,
				candidates: [...chatState.resendCandidates],
				complete: resolve,
				fail: reject,
			};
		});
	}

	function cancelReload(): void {
		if (reloadInProgress || !reloadRequest) return;
		const request = reloadRequest;
		reloadRequest = null;
		request.complete();
	}

	async function confirmReload(): Promise<void> {
		const request = reloadRequest;
		if (!request || reloadInProgress) return;
		reloadInProgress = true;
		try {
			await reloadChatFromNative(ws, chatState, request.chatId);
			if (request.chatId === sessions.selectedChatId && scroll.isPinnedToBottom) {
				scroll.prepareInitialBottomRestore(request.chatId);
			}
			reloadRequest = null;
			request.complete();
		} catch (error) {
			reloadRequest = null;
			request.fail(error);
		} finally {
			reloadInProgress = false;
		}
	}

	function openCommit(): void {
		if (!projectPath || !quickGitSummaryForProject) return;
		if (appShell.isMobile) {
			void workspace.focusMobileSingleton('commit');
			return;
		}
		void workspace.openSingleton('commit', 'sidebar');
	}

	function toggleCommitBranchDropdown(): void {
		if (!projectPath) return;
		if (quickGitBranches.showBranchDropdown) {
			quickGitBranches.closeBranchDropdown();
			return;
		}
		void quickGitBranches.openBranchDropdown(projectPath);
	}

	async function switchCommitBranch(branch: string): Promise<void> {
		if (!projectPath || !effectiveProjectKey) return;
		await quickGitBranches.switchBranch(
			projectPath,
			branch,
			undefined,
			CHAT_SURFACE_ID,
			effectiveProjectKey,
		);
	}
</script>

<div class="h-full flex flex-col">
	<div class="relative flex-1 min-h-0">
		<svelte:boundary>
			<ConversationFeed
				bind:scrollContainer
				onscroll={() => scroll.handleScroll()}
				onUserScrollIntent={(direction) => scroll.noteUserScrollIntent(direction)}
				onLoadEarlier={() => void scroll.requestPage('earlier', 'button')}
				onLoadLater={() => void scroll.requestPage('later', 'button')}
				onPermissionDecision={(permissionOccurrenceId, decision) => (
					controller.handlePermissionDecision(permissionOccurrenceId, decision))}
				onExitPlanMode={(permissionOccurrenceId, choice, plan) => (
					controller.handleExitPlanMode(permissionOccurrenceId, choice, plan))}
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
				reserveTopFloatingToolbar={reserveFeedTopFloatingToolbar}
				{isPreparingInitialScroll}
				{isVisible}
				pinnedToBottom={scroll.isPinnedToBottom}
				surfaceIdentity={conversationSurfaceIdentity}
				onViewportPortChange={(port) => (conversationViewport = port)}
				{onRegisterPrepareHide}
				onInitialEndRestored={() => scroll.completeInitialBottomRestore()}
				isProcessing={selectedIsProcessing}
				{textScale}
			/>
			{#snippet failed(error)}
				<MessageRenderFallback {error} />
			{/snippet}
		</svelte:boundary>

		{#if (chatState.isUserScrolledUp || scroll.isScrollingToBottom) && chatState.displayMessageCount > 0}
			{#if scroll.canScrollToTop && !scroll.isScrollingToBottom}
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
			{/if}
			<Button
				variant="outline"
				size="icon"
				class="absolute bottom-14 right-5 sm:right-6 z-20 w-11 h-11 rounded-full shadow-md hover:shadow-lg"
				onclick={scrollToBottomAndFill}
				disabled={scroll.isScrollingToBottom}
				title={m.workspace_scroll_to_bottom()}
			>
				{#if scroll.isScrollingToBottom}
					<Loader2 class="w-5 h-5 animate-spin" />
				{:else}
					<ArrowDown class="w-5 h-5" />
				{/if}
			</Button>
		{/if}
	</div>

	<div bind:this={queueControlsContainer} class={queueShellClass}>
		<div class={queueFrameClass}>
			<QueueControls
				chatId={sessions.selectedChatId}
				queue={activeQueue}
				canInterrupt={canInterruptSelectedChat}
				canSteer={canSteerSelectedChat}
				onInterrupt={() => controller.handleInterruptAndSend()}
				onSteer={(entry, reorderRevision) =>
					controller.handleSteerQueuedInput(entry, reorderRevision)}
				onPause={() => controller.handleQueuePause()}
				onResume={(pauseId) => controller.handleQueueResume(pauseId)}
				onQueueControlError={(action, error) => controller.handleQueueControlError(action, error)}
				onEdit={editQueuedInput}
				onOpenManager={openQueuedInputsManager}
				onDelete={(id) => controller.handleDeleteQueuedInput(id)}
			/>
		</div>
	</div>

	<PromptComposer
		{isVisible}
		{isPresented}
		{directAdmissionPending}
		{composerEditorOpenRequestId}
		onsubmit={onSubmit}
		{onSteerPreferredSubmit}
		onModelChange={(next) => controller.handleModelSelectionChange(next)}
		onPermissionModeChange={(m) => controller.handlePermissionModeChange(m)}
		onThinkingModeChange={(m) => controller.handleThinkingModeChange(m)}
		onAgentSettingChange={(descriptor, value) =>
			controller.handleAgentSettingChange(descriptor, value)}
		onAbort={() => controller.handleAbort()}
		quickCommitTrayVisible={quickGitTrayVisible}
		quickCommitSummary={quickGitSummaryForProject}
		quickCommitRefreshing={quickGitRefreshingForProject}
		quickCommitError={quickGitErrorForProject}
		quickCommitBranchSelector={quickGitBranchSelectorControls}
		onQuickCommit={openCommit}
	/>

	{#if userMessageNavigator.open}
		<UserMessageNavigatorDialog controller={userMessageNavigator} />
	{/if}

	{#if queuedInputsDialogOpen}
		<QueuedInputsDialog
			open={true}
			queue={dialogQueue}
			editor={queuedInputEditor}
			onClose={closeQueuedInputsDialog}
			onCreate={async (content) => {
				if (!queuedInputsDialogChatId) return;
				await controller.createQueueEntryForChat(queuedInputsDialogChatId, content);
			}}
			onReplace={async (entryId, content, expectedRevision) => {
				if (!queuedInputsDialogChatId) return;
				await controller.replaceQueueEntryForChat(
					queuedInputsDialogChatId,
					entryId,
					content,
					expectedRevision,
				);
			}}
			onDelete={async (entryId) => {
				if (!queuedInputsDialogChatId) return;
				await controller.deleteQueueEntryForChat(queuedInputsDialogChatId, entryId);
			}}
			onMove={async (source, target, placement, reorderRevision) => {
				const chatId = queuedInputsDialogChatId;
				if (!chatId) return;
				await controller.moveQueueEntryForChat(chatId, source, target, placement, reorderRevision);
			}}
			onPause={async () => {
				if (!queuedInputsDialogChatId) return;
				await controller.pauseQueueForChat(queuedInputsDialogChatId);
			}}
			onResume={async (pauseId) => {
				if (!queuedInputsDialogChatId) return;
				await controller.resumeQueueForChat(queuedInputsDialogChatId, pauseId);
			}}
		/>
	{/if}

	<ReloadChatDialog
		open={reloadRequest !== null}
		candidates={reloadRequest?.candidates ?? []}
		busy={reloadInProgress}
		onCancel={cancelReload}
		onConfirm={() => void confirmReload()}
	/>
	<HandoffForkDialog
		open={controller.handoffForkConfirmation.isOpen}
		onCancel={() => controller.handoffForkConfirmation.cancel()}
		onConfirm={() => controller.handoffForkConfirmation.confirm()}
	/>
</div>
