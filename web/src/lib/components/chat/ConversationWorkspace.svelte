<script lang="ts">
	import { errorMessage } from '$lib/utils/error-message.js';
	// Owns the singleton conversation runtime, composer, and dialogs while
	// rendered panels own transcript presentation and scrolling.

	import { onDestroy, onMount, untrack } from 'svelte';
	import type { ComposerAvailabilityNotice } from '$lib/chat/composer/composer-availability.js';
	import PromptComposer from './composer/PromptComposer.svelte';
	import QueuedInputEditorDialog from './queue/QueuedInputEditorDialog.svelte';
	import HandoffForkDialog from './HandoffForkDialog.svelte';
	import ClearChatDialog from './ClearChatDialog.svelte';
	import ExecutorHandoffDialog from './ExecutorHandoffDialog.svelte';
	import ReloadChatDialog from './ReloadChatDialog.svelte';
	import UserMessageNavigatorDialog from './transcript/UserMessageNavigatorDialog.svelte';
	import type { ConversationPanelActions } from './conversation-panel-actions.js';
	import { ConversationBranchController } from './conversation-branch-controller.js';
	import { createConversationPanelActions } from './conversation-panel-action-dispatcher.js';
	import { INITIAL_VISIBLE_MESSAGES } from '$lib/chat/transcript/active-transcript-state.svelte.js';
	import { recentRecallPrompts } from '$lib/chat/composer/prompt-recall';
	import { UserMessage } from '$shared/chat-types';
	import { sameGitProject } from '$lib/git/targets/git-target.js';
	import type { ProjectTarget } from '$shared/project-resolution';
	import { ChatTranscriptCache } from '$lib/chat/transcript/chat-transcript-cache.svelte.js';
	import { ComposerState } from '$lib/chat/composer/composer.svelte.js';
	import type { ChatDraftAppend } from '$lib/chat/composer/chat-draft-append.js';
	import type { SubagentToolbarState } from '$lib/chat/transcript/subagent-toolbar-state.svelte.js';
	import type { AgentState } from '$lib/chat/conversation/agent-state.svelte.js';
	import {
		reloadChatFromNative,
		type ChatReloadOptions,
		type ChatReloadOutcome,
	} from '$lib/chat/conversation/reload-chat.js';
	import { ReloadChatDialogState } from './reload-chat-dialog-state.svelte.js';
	import { gotoChat } from '$lib/chat/actions/chat-navigation.js';
	import { StartupCoordinator } from '$lib/chat/conversation/startup-coordinator.js';
	import { createDrainCursor } from '$lib/ws/drain';
	import { ChatReconnectCoordinator } from '$lib/ws/reconnect-coordinator.svelte';
	import { mountConversationRouter } from '$lib/chat/conversation/conversation-router-adapter.svelte.js';
	import { applyChatMessageBatchActivity } from '$lib/chat/sessions/chat-message-batch-activity.js';
	import { ConversationSessionController } from '$lib/chat/conversation/conversation-session-controller.svelte.js';
	import { requiresQueuedSubmission } from '$lib/chat/conversation/submission-classifier.js';
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
		getSidebarOrder,
		getLocalSettings,
		getAppShell,
		getWs,
		setComposerState,
		setAgentState,
		getReadReceiptOutbox,
		getModelCatalog,
		getExecutors,
		getRemoteSettings,
		getNotifications,
		getWorkspaceCoordinator,
		getSingletonSurfaces,
		getWorkspaceShortcuts,
		getGitQuickSummary,
		getProjectResolution,
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
		availabilityNotice?: ComposerAvailabilityNotice | null;
		onChooseProjectFolder?: (chatId: string) => void;
		agentState: AgentState;
		subagentToolbar: SubagentToolbarState;
		transcriptCache?: ChatTranscriptCache;
		reserveMobileToolbar?: boolean;
		isVisible?: boolean;
		isPresented?: boolean;
	}


	let {
		onRegisterSubmit,
		onRegisterAppendToDraft,
		onRegisterReload,
		onRegisterUserMessageNavigator,
		onRegisterPrepareHide,
		onRegisterPanelActions,
		onComposerHeightChange,
		availabilityNotice,
		onChooseProjectFolder,
		agentState: providedAgentState,
		subagentToolbar,
		transcriptCache: providedTranscriptCache,
		reserveMobileToolbar = false,
		isVisible = true,
		isPresented: isPresentedOverride,
	}: ConversationWorkspaceProps = $props();
	const agentState = untrack(() => providedAgentState);
	const isPresented = $derived(isPresentedOverride ?? isVisible);

	function getInitialTranscriptCache(): ChatTranscriptCache {
		return providedTranscriptCache ?? new ChatTranscriptCache({ limit: INITIAL_VISIBLE_MESSAGES });
	}

	const sessions = getChatSessions();
	const localSettings = getLocalSettings();
	const appShell = getAppShell();
	const ws = getWs();
	const readReceiptOutbox = getReadReceiptOutbox();
	const rootModelCatalog = getModelCatalog();
	const executors = getExecutors();
	const remoteSettings = getRemoteSettings();
	const notifications = getNotifications();
	const workspace = getWorkspaceCoordinator();
	const singletonSurfaces = getSingletonSurfaces();
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
	const modelCatalog = $derived(rootModelCatalog.forExecutor(agentState.executorId));
	const lifecycle = new CurrentConversationLifecycle({
		lifecycles: conversationLifecycles,
		getSelectedChatId: () => sessions.selectedChatId,
	});
	const conversationUi = getConversationUi();

	let queueEditorChatId = $state<string | null>(null);
	let composerEditorOpenRequestId = $state(0);
	const reloadDialog = new ReloadChatDialogState();
	const editorQueue = $derived(conversationUi.getExecutionControl(queueEditorChatId)?.queue ?? null);
	const composerRequiresQueuedSubmission = $derived.by(() => {
		const chatId = sessions.selectedChatId;
		return requiresQueuedSubmission({
			isProcessing: isChatProcessing(sessions.selectedChat),
			control: conversationUi.getExecutionControl(chatId),
		});
	});
	const queuedInputEditor = new QueuedInputEditorState({
		get queue() {
			return editorQueue;
		},
	});
	const quickGit = getGitQuickSummary();
	const quickGitBranches = getGitBranchActions();
	const projectResolution = getProjectResolution();
	const startupCoordinator = new StartupCoordinator();
	const reconnectCoordinator = new ChatReconnectCoordinator({
		ws,
		panels: conversationPanels,
		conversationUi,
		sessions,
		getBackgroundCursors: (limit) => transcriptCache.listCursors(limit),
		markBackgroundStale: (chatId) => conversationPanels.markChatStale(chatId),
		onBackgroundMessages: (chatId, transcriptViewId, messages, firstOrdinal, lastOrdinal) => {
			const applied = transcriptCache.applyMessages(chatId, transcriptViewId, {
				messages,
				firstOrdinal,
				lastOrdinal,
			});
			if (applied.status !== 'applied') return false;
			conversationPanels.observeRecoveredMessages(chatId, messages);
			applyChatMessageBatchActivity(
				sessions,
				chatId,
				messages.map((entry) => entry.message),
			);
			return true;
		},
	});

	setComposerState(composerState);
	setAgentState(agentState);

	const selectedIsProcessing = $derived(isChatProcessing(sessions.selectedChat));
	const selectedTitle = $derived(sessions.selectedChat?.title || 'Root');
	const selectedModel = $derived(sessions.selectedChat?.model ?? agentState.model);
	const recallPrompts = $derived(recentRecallPrompts(chatState.entries));
	const subagentModel = $derived.by(() => {
		const index = chatState.rowIndex;
		const optimistic = index.hasSubagentEvents ? chatState.visibleOptimisticInputs : [];
		const messages = !index.hasSubagentEvents ? [] : optimistic.length === 0 ? index.subagentMessages : [
			...index.subagentMessages,
			...optimistic.map(input => new UserMessage(input.createdAt, input.content)),
		];
		return buildSubagentManagementModel(messages, {
			rootTitle: selectedTitle,
			rootModel: selectedModel,
			rootStatus: selectedIsProcessing ? 'running' : 'idle',
		});
	});
	const canInterruptSelectedChat = $derived(
		selectedIsProcessing && lifecycle.loadingStatus?.can_interrupt !== false,
	);
	const drainHandle = createDrainCursor(ws);
	onDestroy(() => {
		controller.executorHandoff.cancel();
		reloadDialog.dispose();
		controller.clearHistory.handleChatSwitch(null);
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
		notifyCompletion: (chatId) => {
			if (!allowsConversationalActions(chatId)) return;
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

	const sidebarOrder = getSidebarOrder();
	const controller = new ConversationSessionController({
		sessions,
		moveChatToBoundary: (chatId, boundary) => sidebarOrder.moveChatToBoundary(chatId, boundary),
		chatState,
		composerState,
		agentState,
		lifecycle,
		lifecycleForChat: (chatId) => conversationLifecycles.forChat(chatId),
		conversationUi,
		startupCoordinator,
		get modelCatalog() {
			return modelCatalog;
		},
		modelCatalogForExecutor: (executorId) => rootModelCatalog.forExecutor(executorId),
		canSubmitToExecutor: (executorId) =>
			executors.isReady(executorId) && rootModelCatalog.forExecutor(executorId).isValidated,
		getExecutionDefaults: (agentId, executorId) => {
			const modelCatalog = rootModelCatalog.forExecutor(executorId ?? agentState.executorId);
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
			openForkedChat: (chatId, sourceChatId) => {
				void workspace
					.openForkedChat(chatId, sourceChatId, localSettings.forkOpenPlacement)
					.catch((error) => {
						notifications.error(errorMessage(error, m.workspace_open_failed()));
					});
			},
		},
		requestProcessingSnapshot: (source) => ws.requestProcessingSnapshot(source),
		onProjectUnavailable: async (target) => {
			if (
				target.kind === 'chat' &&
				(sessions.byId[target.chatId]?.projectPath !== target.projectPath ||
					(sessions.byId[target.chatId]?.executorId ?? 'local') !== (target.executorId ?? 'local'))
			)
				return;
			const lease = projectResolution.retain(target);
			try {
				await lease.retry();
			} finally {
				lease.release();
			}
		},
		isProjectUnavailable: (chatId) => {
			const chat = sessions.byId[chatId];
			if (!chat?.projectPath) return false;
			const executorId = chat.executorId ?? 'local';
			const target: ProjectTarget =
				chat.status === 'draft'
					? { kind: 'path', executorId, projectPath: chat.projectPath }
					: { kind: 'chat', executorId, chatId, projectPath: chat.projectPath };
			return projectResolution.snapshotFor(target).kind === 'unavailable';
		},
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
	function allowsConversationalActions(chatId: string): boolean {
		const chat = sessions.byId[chatId];
		if (!chat) return false;
		const agent = rootModelCatalog.forExecutor(chat.executorId).getAgent(chat.agentId);
		return agent?.executionPolicy === 'conversation';
	}

	const branches = new ConversationBranchController({
		sessions, executors, conversationPanels, workspace, quickGitBranches, quickGit, projectResolution,
	});
	const panelActions = createConversationPanelActions({
		conversationPanels, sessions, rootModelCatalog, controller, composerState, branches,
		quickGitBranches, workspace, appShell, allowsConversationalActions, editQueuedInput,
		openCommitForPanel,
		onChooseProjectFolder: chatId => onChooseProjectFolder?.(chatId),
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
		untrack(() => controller.handleChatSwitchIfChanged(chatId));
	});

	$effect(() => {
		const chatId = sessions.selectedChatId;
		if (queueEditorChatId && queueEditorChatId !== chatId) {
			closeQueueEditor();
		}
		if (reloadDialog.open && !reloadDialog.running && reloadDialog.chatId !== chatId) {
			reloadDialog.cancel();
		}
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

	function editQueuedInput(chatId: string, entry: QueueEntry): void {
		if (!sessions.byId[chatId]) return;
		queueEditorChatId = chatId;
		queuedInputEditor.begin(entry);
	}

	function closeQueueEditor(): void {
		queueEditorChatId = null;
		queuedInputEditor.close();
	}

	function jumpToToolInput(anchorId: string): void {
		void currentPanel()?.scroll.jumpToDomAnchor(anchorId);
	}

	// Exposes a chat submit function for sibling components (e.g. git review).
	async function submitToActiveChat(message: string): Promise<boolean> {
		const chatId = sessions.selectedChatId;
		if (!chatId || !allowsConversationalActions(chatId)) return false;
		try {
			return isAcceptedConversationSubmission(await controller.submitForChat(chatId, message));
		} catch {
			return false;
		}
	}

	function appendToActiveDraft(block: string) {
		const chatId = sessions.selectedChatId;
		if (!chatId || !allowsConversationalActions(chatId)) return 'unavailable';
		return composerState.appendDraftBlock(chatId, block);
	}

	async function reloadSelectedChat(chatId: string): Promise<void> {
		if (!chatId || chatId !== sessions.selectedChatId) {
			throw new Error(m.sidebar_chats_reload_requires_open_chat());
		}
		if (reloadDialog.open) throw new Error(m.sidebar_chats_reload_already_pending());
		return reloadDialog.request(chatId, [...chatState.resendCandidates]);
	}

	async function reloadFromNative(
		chatId: string,
		options: ChatReloadOptions,
	): Promise<ChatReloadOutcome> {
		const panel = panelForChat(chatId);
		if (!panel) throw new Error(m.sidebar_chats_reload_requires_open_chat());
		const outcome = await reloadChatFromNative(ws, conversationPanels, chatId, options);
		if (
			outcome === 'reloaded' &&
			chatId === sessions.selectedChatId &&
			panel.scroll.isPinnedToBottom
		) {
			panel.scroll.prepareInitialBottomRestore(chatId);
		}
		return outcome;
	}

	function openCommitForPanel(surfaceId: ChatViewSurfaceId, chatId: string): void {
		const executorId = sessions.byId[chatId]?.executorId ?? 'local';
		if (!executors.gitAvailable(executorId)) return;
		const projectPath = sessions.byId[chatId]?.projectPath;
		if (!projectPath) return;
		const target = { executorId, projectPath };
		const commit = singletonSurfaces.commit();
		if (!commit.target.selectProject(target) && !sameGitProject(commit.target.requestTarget, target)) {
			notifications.info(m.commit_surface_busy_target_retained(), { key: 'commit-busy-target' });
		}
		const targetWindowId = workspace.windowOf(surfaceId);
		let opening: Promise<void> | null = null;
		if (appShell.isMobile) {
			opening = workspace.focusMobileSingleton('commit');
		} else if (targetWindowId) {
			opening = workspace.openSingletonAsTab('commit', targetWindowId);
		}
		if (!opening) return;
		void opening.catch((error) => {
			notifications.error(errorMessage(error, m.workspace_open_failed()));
		});
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
			requiresQueuedSubmission={composerRequiresQueuedSubmission}
			{composerEditorOpenRequestId}
			onsubmit={onSubmit}
			{onSteerPreferredSubmit}
			{availabilityNotice}
			onModelChange={(next) => controller.handleModelSelectionChange(next)}
			onExecutorChange={(executorId) =>
				controller.handleModelSelectionChange({
					executorId,
					agentId: agentState.agentId,
					modelValue: agentState.model,
				})}
			onPermissionModeChange={(m) => controller.handlePermissionModeChange(m)}
			onThinkingModeChange={(m) => controller.handleThinkingModeChange(m)}
			onAgentSettingChange={(descriptor, value) =>
				controller.handleAgentSettingChange(descriptor, value)}
			resendCandidates={chatState.resendCandidates}
			recallIdentity={sessions.selectedChatId && chatState.activeChatId === sessions.selectedChatId
				? `${sessions.selectedChatId}:${chatState.transcriptViewId}`
				: null}
			{recallPrompts}
			onExcludeResendCandidate={(ordinal) => chatState.excludeResendCandidate(ordinal)}
		/>
	</div>

	{#if userMessageNavigator.open}
		<UserMessageNavigatorDialog controller={userMessageNavigator} />
	{/if}

	{#if queueEditorChatId}
		<QueuedInputEditorDialog
			chatId={queueEditorChatId}
			executionKey={JSON.stringify([sessions.byId[queueEditorChatId]?.executorId, sessions.byId[queueEditorChatId]?.agentId])}
			editor={queuedInputEditor}
			onClose={closeQueueEditor}
			onFocusComposer={(chatId) => {
				if (sessions.selectedChatId === chatId && isPresented)
					composerHost
						?.querySelector<HTMLElement>('[data-composer-markdown-editor] [role="textbox"], textarea')
						?.focus({ preventScroll: true });
			}}
			onCreate={async (content) => {
				if (!queueEditorChatId) return;
				await controller.createQueueEntryForChat(queueEditorChatId, content);
			}}
			onReplace={async (entryId, content, expectedRevision) => {
				if (!queueEditorChatId) return;
				await controller.replaceQueueEntryForChat(
					queueEditorChatId,
					entryId,
					content,
					expectedRevision,
				);
			}}
		/>
	{/if}

	<ReloadChatDialog
		open={reloadDialog.open}
		candidates={reloadDialog.candidates}
		busy={reloadDialog.running}
		cancelling={reloadDialog.cancelling}
		progress={reloadDialog.progress}
		onCancel={() => reloadDialog.cancel()}
		onConfirm={() => void reloadDialog.confirm(reloadFromNative)}
	/>
	<ExecutorHandoffDialog handoff={controller.executorHandoff} />
	<ClearChatDialog
		open={controller.clearHistory.isOpen}
		targetKind={controller.clearHistory.targetKind}
		busy={controller.clearHistory.busy}
		error={controller.clearHistory.error}
		onCancel={() => controller.clearHistory.cancel()}
		onConfirm={() => void controller.clearHistory.confirm()}
	/>
	<HandoffForkDialog
		open={controller.handoffForkConfirmation.isOpen}
		onCancel={() => controller.handoffForkConfirmation.cancel()}
		onConfirm={() => controller.handoffForkConfirmation.confirm()}
	/>
</div>
