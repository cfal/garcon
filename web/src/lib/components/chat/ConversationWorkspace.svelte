<script lang="ts">
	// Owns the singleton conversation runtime, composer, and dialogs while
	// rendered panels own transcript presentation and scrolling.

	import { onDestroy, onMount } from 'svelte';
	import PromptComposer from './PromptComposer.svelte';
	import QueuedInputsDialog from './QueuedInputsDialog.svelte';
	import HandoffForkDialog from './HandoffForkDialog.svelte';
	import ReloadChatDialog from './ReloadChatDialog.svelte';
	import UserMessageNavigatorDialog from './UserMessageNavigatorDialog.svelte';
	import {
		StaleConversationSurfaceError,
		type ConversationPanelActions,
	} from './conversation-panel-actions.js';
	import { INITIAL_VISIBLE_MESSAGES } from '$lib/chat/transcript/active-transcript-state.svelte.js';
	import type { ResendCandidate } from '$shared/chat-view';
	import { searchResultNavigation } from '$lib/chat/actions/search-result-navigation.svelte.js';
	import { ChatTranscriptCache } from '$lib/chat/transcript/chat-transcript-cache.svelte.js';
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
	import { CurrentConversationPanelTranscript } from '$lib/chat/conversation/current-conversation-panel-transcript.js';
	import { CurrentConversationLifecycle } from '$lib/chat/conversation/current-conversation-lifecycle.js';
	import {
		UserMessageNavigatorController,
		type UserMessageNavigatorRegistration,
	} from '$lib/chat/transcript/user-message-navigator-controller.svelte.js';
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
		setComposerState,
		setAgentState,
		getReadReceiptOutbox,
		getModelCatalog,
		getRemoteSettings,
		getNotifications,
		getWorkspaceCoordinator,
		getWorkspaceShortcuts,
		getGitQuickSummary,
		getGitBranchActions,
		getChatDrafts,
		getConversationUi,
		getConversationLifecycles,
		getConversationPanels,
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
		onComposerHeightChange?: (height: number) => void;
		subagentToolbar: SubagentToolbarState;
		transcriptCache?: ChatTranscriptCache;
		reserveMobileToolbar?: boolean;
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
		onComposerHeightChange,
		subagentToolbar,
		transcriptCache: providedTranscriptCache,
		reserveMobileToolbar = false,
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
	const composerAnchorSurfaceId = $derived(workspace.composerAnchorSurfaceId);
	const workspaceShortcuts = getWorkspaceShortcuts();
	const chatDrafts = getChatDrafts();
	const conversationPanels = getConversationPanels();
	const conversationLifecycles = getConversationLifecycles();

	const transcriptCache = getInitialTranscriptCache();
	const chatState = new CurrentConversationPanelTranscript({
		panels: conversationPanels,
		getSelectedChatId: () => sessions.selectedChatId,
	});
	const composerState = new ComposerState(chatDrafts, {
		get activeChatId() {
			return sessions.selectedChatId;
		},
	});
	const agentState = new AgentState();
	const lifecycle = new CurrentConversationLifecycle({
		lifecycles: conversationLifecycles,
		getSelectedChatId: () => sessions.selectedChatId,
	});
	const conversationUi = getConversationUi();

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
		panels: conversationPanels,
		conversationUi,
		sessions,
		getBackgroundCursors: () => transcriptCache.listCursors(20),
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

	setComposerState(composerState);
	setAgentState(agentState);

	const selectedIsProcessing = $derived(isChatProcessing(sessions.selectedChat));
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
	const drainHandle = createDrainCursor(ws);
	onDestroy(() => {
		reloadRequest?.complete();
		reloadRequest = null;
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
		lifecycles: conversationLifecycles,
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
		panels: conversationPanels,
		chatDrafts,
		clearDeletedChat: (chatId) => {
			void workspace.clearDeletedChat(chatId).catch((error) => {
				notifications.error(
					error instanceof Error ? error.message : m.notifications_delete_chat_failed(),
				);
			});
		},
	});
	reconnectCoordinator.mount();

	function currentPanel() {
		return conversationPanels.composerPanel;
	}

	function panelForChat(chatId: string) {
		const current = currentPanel();
		if (current?.chatId === chatId) return current;
		return conversationPanels.panelsForChat(chatId)[0] ?? null;
	}

	function scrollToBottomAndFill(): void {
		void currentPanel()?.scroll.scrollToLatestAndFill();
	}

	const controller = new ConversationSessionController({
		sessions,
		chatState,
		composerState,
		agentState,
		lifecycle,
		lifecycleForChat: (chatId) => conversationLifecycles.forChat(chatId),
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
			currentPanel()?.scroll.setPinnedToBottom(v);
		},
		setInitialBottomRestorePending: (chatId) => {
			if (chatId) panelForChat(chatId)?.scroll.prepareInitialBottomRestore(chatId);
		},
		scrollToBottom: scrollToBottomAndFill,
	});
	const directAdmissionPending = $derived(
		controller.isDirectAdmissionPending(sessions.selectedChatId),
	);
	function assertRenderedPanel(surfaceId: ChatViewSurfaceId, chatId: string) {
		const panel = conversationPanels.panel(surfaceId);
		if (panel?.chatId !== chatId) {
			throw new StaleConversationSurfaceError(surfaceId, chatId);
		}
		return panel;
	}

	const panelActions: ConversationPanelActions = {
		reload(surfaceId, chatId) {
			const panel = assertRenderedPanel(surfaceId, chatId);
			void controller.loadPanelChat(chatId, panel.transcript, (options) =>
				conversationPanels.loadChatSnapshot(chatId, options),
			);
		},
		decidePermission(surfaceId, chatId, permissionOccurrenceId, decision) {
			assertRenderedPanel(surfaceId, chatId);
			controller.handlePermissionDecisionForChat(chatId, permissionOccurrenceId, decision);
		},
		exitPlanMode(surfaceId, chatId, permissionOccurrenceId, choice, plan) {
			assertRenderedPanel(surfaceId, chatId);
			controller.handleExitPlanModeForChat(chatId, permissionOccurrenceId, choice, plan);
		},
		fork(surfaceId, chatId, upToOrdinal) {
			const panel = assertRenderedPanel(surfaceId, chatId);
			void controller.forkChat(chatId, upToOrdinal, panel.transcript);
		},
		async generateTitle(surfaceId, chatId, message, ordinal) {
			assertRenderedPanel(surfaceId, chatId);
			await sessions.generateChatTitleFromMessage(chatId, message, ordinal);
		},
		interruptQueue(surfaceId, chatId) {
			assertRenderedPanel(surfaceId, chatId);
			return controller.handleInterruptAndSendForChat(chatId);
		},
		steerQueue(surfaceId, chatId, entry, reorderRevision) {
			assertRenderedPanel(surfaceId, chatId);
			return controller.handleSteerQueuedInputForChat(chatId, entry, reorderRevision);
		},
		pauseQueue(surfaceId, chatId) {
			assertRenderedPanel(surfaceId, chatId);
			return controller.pauseQueueForChat(chatId);
		},
		resumeQueue(surfaceId, chatId, pauseId) {
			assertRenderedPanel(surfaceId, chatId);
			return controller.resumeQueueForChat(chatId, pauseId);
		},
		reportQueueControlError(surfaceId, chatId, action, error) {
			assertRenderedPanel(surfaceId, chatId);
			controller.handleQueueControlErrorForChat(chatId, action, error);
		},
		editQueue(surfaceId, chatId, entry) {
			assertRenderedPanel(surfaceId, chatId);
			editQueuedInput(chatId, entry);
		},
		openQueue(surfaceId, chatId) {
			assertRenderedPanel(surfaceId, chatId);
			openQueuedInputsManager(chatId);
		},
		deleteQueue(surfaceId, chatId, entryId) {
			assertRenderedPanel(surfaceId, chatId);
			return controller.deleteQueueEntryFromPanelForChat(chatId, entryId);
		},
		stop(surfaceId, chatId) {
			assertRenderedPanel(surfaceId, chatId);
			return controller.handleAbortForChat(chatId);
		},
		openCommit(surfaceId, chatId) {
			assertRenderedPanel(surfaceId, chatId);
			openCommitForPanel(surfaceId, chatId);
		},
		toggleBranch(surfaceId, chatId) {
			assertRenderedPanel(surfaceId, chatId);
			toggleCommitBranchDropdown(chatId);
		},
		closeBranch(surfaceId, chatId) {
			assertRenderedPanel(surfaceId, chatId);
			quickGitBranches.closeBranchDropdown();
		},
		createBranch(surfaceId, chatId) {
			assertRenderedPanel(surfaceId, chatId);
			const chat = sessions.byId[chatId];
			if (chat?.projectPath && chat.effectiveProjectKey) {
				quickGitBranches.openNewBranchDialog(chat.projectPath, surfaceId, chat.effectiveProjectKey);
			}
		},
		switchBranch(surfaceId, chatId, branch) {
			assertRenderedPanel(surfaceId, chatId);
			return switchCommitBranch(surfaceId, chatId, branch);
		},
		searchBranches(surfaceId, chatId, query) {
			assertRenderedPanel(surfaceId, chatId);
			const projectPath = sessions.byId[chatId]?.projectPath;
			if (projectPath) void quickGitBranches.searchBranchRefs(projectPath, query);
		},
		sortBranches(surfaceId, chatId, key, query) {
			assertRenderedPanel(surfaceId, chatId);
			const projectPath = sessions.byId[chatId]?.projectPath;
			if (projectPath) void quickGitBranches.toggleBranchSort(projectPath, key, query);
		},
		closeSwitchBranchDialog(surfaceId, chatId) {
			assertRenderedPanel(surfaceId, chatId);
			if (workspace.composerAnchorSurfaceId === surfaceId && sessions.selectedChatId === chatId) {
				appShell.requestComposerFocus();
			}
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
		void currentPanel()?.scroll.jumpToMessageRow({
			chatId,
			transcriptViewId: chatState.transcriptViewId,
			rowId: `${chatState.transcriptViewId}:${ordinal}`,
		});
	});

	const userMessageNavigator = new UserMessageNavigatorController({
		transcript: chatState,
		getSelectedChatId: () => sessions.selectedChatId,
		reloadTranscript: (chatId) => controller.loadChat(chatId),
		restoreLatestTranscript: (chatId) =>
			panelForChat(chatId)?.scroll.restoreLatestWindow(chatId) ?? Promise.resolve(false),
		loadOlderMessages: (chatId) =>
			panelForChat(chatId)?.scroll.loadEarlierPageForNavigator(chatId) ??
			Promise.resolve('invalidated'),
		jumpToRow: (target) =>
			panelForChat(target.chatId)?.scroll.jumpToMessageRow(target) ??
			Promise.resolve('unavailable'),
	});

	onMount(() => {
		onRegisterSubmit?.(submitToActiveChat);
		onRegisterAppendToDraft?.(appendToActiveDraft);
		onRegisterReload?.(reloadSelectedChat);
		onRegisterUserMessageNavigator?.(() => void userMessageNavigator.openForActiveChat());
		onRegisterPanelActions?.(panelActions);
		onRegisterPrepareHide?.(() => currentPanel()?.prepareForInteractionLoss());
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
			onRegisterPrepareHide?.(null);
		};
	});

	$effect(() => {
		const chatId = sessions.selectedChatId;
		// The selected record may hydrate after the route-selected ID.
		void sessions.selectedChat;
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
					`[data-prompt-editor-dialog][data-workspace-surface-id="${composerAnchorSurfaceId}"]`,
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

	$effect(() => {
		const surfaceId = composerAnchorSurfaceId;
		if (!surfaceId) return;
		return workspaceShortcuts.registerSurface(surfaceId, handleWorkspaceShortcut);
	});

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

	function openQueuedInputsManager(chatId = sessions.selectedChatId): void {
		if (!chatId || !sessions.byId[chatId]) return;
		queuedInputEditor.close();
		queuedInputsDialogChatId = chatId;
		queuedInputsDialogOpen = true;
	}

	function editQueuedInput(chatId: string, entry: QueueEntry): void {
		if (!sessions.byId[chatId]) return;
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
		void currentPanel()?.scroll.jumpToDomAnchor(anchorId);
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
			const panel = panelForChat(request.chatId);
			if (!panel) throw new Error(m.sidebar_chats_reload_failed());
			await reloadChatFromNative(ws, panel.transcript, request.chatId);
			if (request.chatId === sessions.selectedChatId && panel.scroll.isPinnedToBottom) {
				panel.scroll.prepareInitialBottomRestore(request.chatId);
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

	function openCommitForPanel(surfaceId: ChatViewSurfaceId, chatId: string): void {
		const projectPath = sessions.byId[chatId]?.projectPath;
		if (!projectPath || !quickGit.summaryFor(projectPath)) return;
		const targetWindowId = workspace.windowOf(surfaceId);
		let opening: Promise<void> | null = null;
		if (appShell.isMobile) {
			opening = workspace.focusMobileSingleton('commit');
		} else if (targetWindowId) {
			opening = workspace.openSingletonAsTab('commit', targetWindowId);
		}
		if (!opening) return;
		void opening.catch((error) => {
			notifications.error(error instanceof Error ? error.message : m.workspace_open_failed());
		});
	}

	function toggleCommitBranchDropdown(chatId: string): void {
		const projectPath = sessions.byId[chatId]?.projectPath;
		if (!projectPath) return;
		if (
			quickGitBranches.currentProjectPath === projectPath &&
			quickGitBranches.showBranchDropdown
		) {
			quickGitBranches.closeBranchDropdown();
			return;
		}
		void quickGitBranches.openBranchDropdown(projectPath);
	}

	async function switchCommitBranch(
		surfaceId: ChatViewSurfaceId,
		chatId: string,
		branch: string,
	): Promise<void> {
		const chat = sessions.byId[chatId];
		if (!chat?.projectPath || !chat.effectiveProjectKey) return;
		await quickGitBranches.switchBranch(
			chat.projectPath,
			branch,
			undefined,
			surfaceId,
			chat.effectiveProjectKey,
		);
	}

	let composerHost = $state<HTMLDivElement | null>(null);

	$effect(() => {
		const host = composerHost;
		const publish = onComposerHeightChange;
		if (!host || !isVisible) {
			publish?.(0);
			return;
		}
		const publishHeight = () => publish?.(host.getBoundingClientRect().height);
		publishHeight();
		const observer = new ResizeObserver(publishHeight);
		observer.observe(host);
		return () => {
			observer.disconnect();
			publish?.(0);
		};
	});
</script>

<div class="pointer-events-none flex h-full flex-col">
	<div class="min-h-0 flex-1"></div>
	<div
		bind:this={composerHost}
		class="pointer-events-auto"
		data-conversation-composer-host={composerAnchorSurfaceId}
		data-reserve-mobile-toolbar={reserveMobileToolbar}
	>
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
	</div>

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
