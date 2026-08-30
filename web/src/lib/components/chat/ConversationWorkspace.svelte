<script lang="ts">
	// Thin composition shell for the chat workspace. Wires extracted
	// controllers (session, scroll, router) and renders the conversation
	// feed, queue controls, and composer. All business logic lives in
	// the controller modules.

	import { onDestroy, onMount } from 'svelte';
	import ConversationPanel from './ConversationPanel.svelte';
	import PromptComposer from './PromptComposer.svelte';
	import QueuedInputsDialog from './QueuedInputsDialog.svelte';
	import HandoffForkDialog from './HandoffForkDialog.svelte';
	import ReloadChatDialog from './ReloadChatDialog.svelte';
	import UserMessageNavigatorDialog from './UserMessageNavigatorDialog.svelte';
	import {
		StaleConversationSurfaceError,
		type ConversationPanelActions,
	} from './conversation-panel-actions.js';
	import type {
		ConversationPanelPresentationPort,
		ConversationPanelRegistration,
	} from '$lib/chat/conversation/conversation-panel-registry.svelte.js';
	import {
		ActiveTranscriptState,
		INITIAL_VISIBLE_MESSAGES,
	} from '$lib/chat/transcript/active-transcript-state.svelte.js';
	import type { ResendCandidate, TranscriptMessage } from '$shared/chat-view';
	import type { ChatProcessingPhase } from '$shared/chat-types';
	import { searchResultNavigation } from '$lib/chat/actions/search-result-navigation.svelte.js';
	import { ChatTranscriptCache } from '$lib/chat/transcript/chat-transcript-cache.svelte.js';
	import { BackgroundTranscriptLoader } from '$lib/chat/transcript/background-transcript-loader.js';
	import type { ChatWindowPreviewCursor } from '$lib/chat/transcript/chat-window-preview-store.svelte.js';
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
	import type { ConversationPanelRestoreTarget } from '$lib/chat/transcript/conversation-panel-restore-target.js';
	import {
		UserMessageNavigatorController,
		type UserMessageNavigatorRegistration,
	} from '$lib/chat/transcript/user-message-navigator-controller.svelte.js';
	import { ConversationLifecycleState } from '$lib/chat/conversation/conversation-lifecycle-state.svelte.js';
	import { isAcceptedConversationSubmission } from '$lib/chat/conversation/conversation-submission-outcome.js';
	import { QueuedInputEditorState } from '$lib/chat/conversation/queued-input-editor-state.svelte.js';
	import type { QueueEntry } from '$lib/types/chat';
	import { isChatProcessing } from '$lib/chat/sessions/chat-processing.js';
	import { buildSubagentManagementModel } from '$lib/chat/transcript/subagent-management.js';
	import { playCompletionSound } from '$lib/notifications/completion-sound.js';
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
		getNotifications,
		getWorkspaceCoordinator,
		getWorkspaceShortcuts,
		getGitQuickSummary,
		getGitBranchActions,
		getChatProcessingReconciler,
		getChatDrafts,
		getConversationUi,
	} from '$lib/context';
	import type { ChatViewSurfaceId } from '$lib/workspace/surface-types.js';
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
		onRegisterPanelActions?: (actions: ConversationPanelActions | null) => void;
		subagentToolbar: SubagentToolbarState;
		transcriptCache?: ChatTranscriptCache;
		reserveMobileToolbar?: boolean;
		getVisibleChatIds?: () => string[];
		isVisiblePreviewChat?: (chatId: string) => boolean;
		getVisiblePreviewCursor?: (chatId: string) => ChatWindowPreviewCursor | null;
		applyVisiblePreviewMessages?: (
			chatId: string,
			transcriptViewId: string,
			messages: TranscriptMessage[],
			firstOrdinal: number,
			lastOrdinal: number,
		) => boolean | void;
		loadVisiblePreviewSnapshot?: (chatId: string) => Promise<void> | void;
		markVisiblePreviewStale?: (chatId: string) => void;
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
		onRegisterPanelActions,
		subagentToolbar,
		transcriptCache: providedTranscriptCache,
		reserveMobileToolbar = false,
		getVisibleChatIds,
		isVisiblePreviewChat,
		getVisiblePreviewCursor,
		applyVisiblePreviewMessages,
		loadVisiblePreviewSnapshot,
		markVisiblePreviewStale,
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
	const notifications = getNotifications();
	const workspace = getWorkspaceCoordinator();
	const chatSurfaceId = $derived(workspace.currentChatSurfaceId);
	const workspaceShortcuts = getWorkspaceShortcuts();
	const chatDrafts = getChatDrafts();

	const transcriptCache = getInitialTranscriptCache();
	const chatState = new ActiveTranscriptState(transcriptCache);
	const backgroundTranscriptLoader = new BackgroundTranscriptLoader({ cache: transcriptCache });
	const composerState = new ComposerState(chatDrafts, {
		get activeChatId() {
			return sessions.selectedChatId;
		},
	});
	const agentState = new AgentState();
	const lifecycle = new ConversationLifecycleState();
	const conversationUi = getConversationUi();
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
		clearTurnPermissionRequests: (chatId) =>
			conversationUi.clearTurnPermissionRequestsForChat(chatId),
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
			applyVisiblePreviewMessages?.(chatId, transcriptViewId, messages, firstOrdinal, lastOrdinal),
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

	const selectedIsProcessing = $derived(isChatProcessing(sessions.selectedChat));
	const projectPath = $derived(sessions.selectedChat?.projectPath || null);
	const effectiveProjectKey = $derived(sessions.selectedChat?.effectiveProjectKey ?? null);
	const quickGitSummaryForProject = $derived(quickGit.summaryFor(projectPath));
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
	let panelPresentation: ConversationPanelPresentationPort | null = null;

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
		notifyCompletion: () => {
			void playCompletionSound({
				mode: localSettings.completionSoundMode,
				volume: localSettings.completionSoundVolume,
				visibility: localSettings.completionSoundVisibility,
			});
		},
		transcriptCache,
		backgroundTranscriptLoader,
		chatDrafts,
		clearDeletedChat: (chatId) => {
			void workspace.clearDeletedChat(chatId).catch((error) => {
				notifications.error(
					error instanceof Error ? error.message : m.notifications_delete_chat_failed(),
				);
			});
		},
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

	// Scroll controller.
	const scroll = new ConversationScrollController({
		getScrollContainer: () => panelPresentation?.getScrollContainer() ?? null,
		getViewport: () => panelPresentation?.getViewport() ?? null,
		getQueueContainer: () => panelPresentation?.getQueueContainer(),
		chatState,
		getChatId: () => sessions.selectedChatId,
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
				agentSettings:
					defaults.agentSettingsById[agentId] ?? modelCatalog.getDefaultAgentSettings(agentId),
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
	let lastPanelRestoreTarget: ConversationPanelRestoreTarget = { kind: 'end' };
	const livePanel = {
		get surfaceId() {
			return chatSurfaceId as ChatViewSurfaceId;
		},
		get chatId() {
			return sessions.selectedChatId ?? '';
		},
		transcript: chatState,
		lifecycle,
		scroll,
		attachPresentation(port: ConversationPanelPresentationPort) {
			panelPresentation = port;
			const binding = port;
			onRegisterPrepareHide?.(() => {
				lastPanelRestoreTarget = binding.captureRestoreTarget() ?? lastPanelRestoreTarget;
				binding.closeTransients();
			});
			return () => {
				if (panelPresentation !== binding) return;
				lastPanelRestoreTarget = binding.captureRestoreTarget() ?? lastPanelRestoreTarget;
				binding.closeTransients();
				panelPresentation = null;
				onRegisterPrepareHide?.(null);
			};
		},
		prepareForInteractionLoss() {
			panelPresentation?.closeTransients();
		},
		prepareForHide() {
			lastPanelRestoreTarget =
				panelPresentation?.captureRestoreTarget() ?? lastPanelRestoreTarget;
			panelPresentation?.closeTransients();
			return lastPanelRestoreTarget;
		},
		async restore() {},
		destroy() {},
	} satisfies ConversationPanelRegistration;

	function assertCurrentSurface(surfaceId: ChatViewSurfaceId, chatId: string): void {
		if (workspace.currentChatSurfaceId !== surfaceId || sessions.selectedChatId !== chatId) {
			throw new StaleConversationSurfaceError(surfaceId, chatId);
		}
	}

	const panelActions: ConversationPanelActions = {
		reload(surfaceId, chatId) {
			assertCurrentSurface(surfaceId, chatId);
			void controller.loadChat(chatId);
		},
		decidePermission(surfaceId, chatId, permissionOccurrenceId, decision) {
			assertCurrentSurface(surfaceId, chatId);
			controller.handlePermissionDecision(permissionOccurrenceId, decision);
		},
		exitPlanMode(surfaceId, chatId, permissionOccurrenceId, choice, plan) {
			assertCurrentSurface(surfaceId, chatId);
			controller.handleExitPlanMode(permissionOccurrenceId, choice, plan);
		},
		fork(surfaceId, chatId, upToOrdinal) {
			assertCurrentSurface(surfaceId, chatId);
			void controller.forkChat(chatId, upToOrdinal);
		},
		async generateTitle(surfaceId, chatId, message, ordinal) {
			assertCurrentSurface(surfaceId, chatId);
			await sessions.generateChatTitleFromMessage(chatId, message, ordinal);
		},
		interruptQueue(surfaceId, chatId) {
			assertCurrentSurface(surfaceId, chatId);
			return controller.handleInterruptAndSend();
		},
		steerQueue(surfaceId, chatId, entry, reorderRevision) {
			assertCurrentSurface(surfaceId, chatId);
			return controller.handleSteerQueuedInput(entry, reorderRevision);
		},
		pauseQueue(surfaceId, chatId) {
			assertCurrentSurface(surfaceId, chatId);
			return controller.pauseQueueForChat(chatId);
		},
		resumeQueue(surfaceId, chatId, pauseId) {
			assertCurrentSurface(surfaceId, chatId);
			return controller.resumeQueueForChat(chatId, pauseId);
		},
		reportQueueControlError(surfaceId, chatId, action, error) {
			assertCurrentSurface(surfaceId, chatId);
			controller.handleQueueControlError(action, error);
		},
		editQueue(surfaceId, chatId, entry) {
			assertCurrentSurface(surfaceId, chatId);
			editQueuedInput(entry);
		},
		openQueue(surfaceId, chatId) {
			assertCurrentSurface(surfaceId, chatId);
			openQueuedInputsManager();
		},
		deleteQueue(surfaceId, chatId, entryId) {
			assertCurrentSurface(surfaceId, chatId);
			return controller.deleteQueueEntryForChat(chatId, entryId);
		},
		stop(surfaceId, chatId) {
			assertCurrentSurface(surfaceId, chatId);
			return controller.handleAbort();
		},
		openCommit(surfaceId, chatId) {
			assertCurrentSurface(surfaceId, chatId);
			openCommit();
		},
		toggleBranch(surfaceId, chatId) {
			assertCurrentSurface(surfaceId, chatId);
			toggleCommitBranchDropdown();
		},
		closeBranch(surfaceId, chatId) {
			assertCurrentSurface(surfaceId, chatId);
			quickGitBranches.closeBranchDropdown();
		},
		createBranch(surfaceId, chatId) {
			assertCurrentSurface(surfaceId, chatId);
			if (projectPath && effectiveProjectKey) {
				quickGitBranches.openNewBranchDialog(projectPath, surfaceId, effectiveProjectKey);
			}
		},
		switchBranch(surfaceId, chatId, branch) {
			assertCurrentSurface(surfaceId, chatId);
			return switchCommitBranch(branch);
		},
		searchBranches(surfaceId, chatId, query) {
			assertCurrentSurface(surfaceId, chatId);
			if (projectPath) void quickGitBranches.searchBranchRefs(projectPath, query);
		},
		sortBranches(surfaceId, chatId, key, query) {
			assertCurrentSurface(surfaceId, chatId);
			if (projectPath) void quickGitBranches.toggleBranchSort(projectPath, key, query);
		},
		closeSwitchBranchDialog(surfaceId, chatId) {
			assertCurrentSurface(surfaceId, chatId);
			appShell.requestComposerFocus();
		},
	};
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
		onRegisterPanelActions?.(panelActions);
		const unregisterSubagentToolbar = subagentToolbar.register({
			get model() {
				return subagentModel;
			},
			jumpToTool: jumpToToolInput,
		});

		return () => {
			unregisterSubagentToolbar();
			onRegisterUserMessageNavigator?.(null);
			onRegisterPanelActions?.(null);
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

	function handleWorkspaceShortcut(event: KeyboardEvent): boolean {
		if (!isPresented) return false;
		const targetsPresentedComposerEditor =
			event.target instanceof Element &&
			Boolean(
				event.target.closest(
					`[data-prompt-editor-dialog][data-workspace-surface-id="${chatSurfaceId}"]`,
				),
			);
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

	$effect(() => workspaceShortcuts.registerSurface(chatSurfaceId, handleWorkspaceShortcut));

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
		const opening = appShell.isMobile
			? workspace.focusMobileSingleton('commit')
			: workspace.openSingletonAsTab('commit', workspace.currentWindowId);
		void opening.catch((error) => {
			notifications.error(error instanceof Error ? error.message : m.workspace_open_failed());
		});
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
			chatSurfaceId,
			effectiveProjectKey,
		);
	}
</script>

<div class="flex h-full flex-col">
	<div class="flex min-h-0 flex-1">
		{#if sessions.selectedChat && chatSurfaceId}
			<ConversationPanel
				surfaceId={chatSurfaceId}
				chat={sessions.selectedChat}
				panel={livePanel}
				isCurrent={true}
				{isVisible}
				actions={panelActions}
				{reserveMobileToolbar}
			/>
		{/if}
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
		resendCandidates={chatState.resendCandidates}
		onExcludeResendCandidate={(ordinal) => chatState.excludeResendCandidate(ordinal)}
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
