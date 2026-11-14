<script lang="ts">
	import { COMPOSER_STATUS_BAR_DEFAULTS } from '$lib/chat/composer/composer-status-bar.js';
	import { unusedSingletonFactories } from '$lib/workspace/__tests__/unused-singleton-factories';
	import { setExecutorsTestContext } from '$lib/executors/__tests__/executors-test-context';
	setExecutorsTestContext();
	import { onDestroy, tick, untrack } from 'svelte';
	import { SubagentToolbarState } from '$lib/chat/transcript/subagent-toolbar-state.svelte.js';
	import ConversationWorkspace from '../ConversationWorkspace.svelte';
	import ConversationPanel from '../ConversationPanel.svelte';
	import {
		setAppShell,
		setChatSessions,
		setLocalSettings,
		setModelCatalog,
		setNotifications,
		setReadReceiptOutbox,
		setRemoteSettings,
		setWs,
		setWorkspaceCoordinator,
		setWorkspaceShortcuts,
		setTransientLayers,
		setGitQuickSummary,
		setGitBranchActions,
		setChatProcessingReconciler,
		setChatDrafts,
		setConversationUi,
		setConversationLifecycles,
		setConversationPanels,
		setProjectResolution,
		setSingletonSurfaces,
	} from '$lib/context';
	import { SingletonSurfaceRegistry } from '$lib/workspace/singleton-surfaces.svelte.js';
	import { createGitSurfaceTestDeps } from '$lib/git/__tests__/git-surface-test-deps.js';
	import { CommitController } from '$lib/git/commit/commit-controller.svelte.js';
	import { PullRequestsStore } from '$lib/git/pull-requests/pull-requests-store.svelte.js';
	import { PullRequestReviewsStore } from '$lib/git/pull-requests/pull-request-reviews-store.svelte.js';
	import { ChatDraftStore } from '$lib/chat/composer/chat-draft-store.svelte.js';
	import { createNotificationsStore } from '$lib/stores/notifications.svelte.js';
	import type { ChatSessionRecord } from '$lib/chat/sessions/chat-session-types';
	import type { ConversationPanelActions } from '../conversation-panel-actions.js';
	import type { DrainCursor } from '$lib/ws/connection.svelte';
	import type { ChatProcessingPresentationRegistry } from '$lib/ws/chat-processing-reconciler.svelte.js';
	import KeyboardShortcuts from '$lib/components/shared/KeyboardShortcuts.svelte';
	import { WorkspaceInteractionGate } from '$lib/workspace/workspace-interaction-gate.svelte';
	import { TransientLayerRegistry } from '$lib/workspace/transient-layers.svelte';
	import {
		WorkspaceShortcutDispatcher,
		type WorkspaceShortcutDeps,
	} from '$lib/workspace/workspace-shortcuts';
	import type { WorkspaceCoordinator } from '$lib/workspace/workspace-coordinator.svelte.js';
	import { CANONICAL_CHAT_SURFACE_ID } from '$lib/workspace/canonical-layout.js';
	import { GitQuickSummaryStore } from '$lib/git/surface/git-quick-summary.svelte.js';
	import { GitBranchSelectorState } from '$lib/git/targets/git-branch-selector-state.svelte.js';
	import { ConversationUiState } from '$lib/chat/conversation/conversation-ui-state.svelte.js';
	import { AsyncQuestionController } from '$lib/chat/conversation/async-question-controller.svelte.js';
	import { setAsyncQuestionController } from '$lib/chat/conversation/async-question-context.js';
	import { ConversationLifecycleRegistry } from '$lib/chat/conversation/conversation-lifecycle-registry.svelte.js';
	import { ConversationPanelRegistry } from '$lib/chat/conversation/conversation-panel-registry.svelte.js';
	import { ConversationTranscriptOverlayStore } from '$lib/chat/transcript/conversation-transcript-overlay-store.svelte.js';
	import { ChatTranscriptCache } from '$lib/chat/transcript/chat-transcript-cache.svelte.js';
	import { ProjectResolutionStore } from '$lib/workspace/project-resolution-store.svelte.js';
	import GitBranchSelector from '$lib/components/git/GitBranchSelector.svelte';
	import type { FocusOwner } from '$lib/workspace/surface-types.js';
	import type { AgentMetadata } from '$lib/agents/model-catalog-store.svelte.js';
	import type { ChatDraftAppend } from '$lib/chat/composer/chat-draft-append.js';
	import { sameFocusOwner } from '$lib/workspace/workspace-presentation-controller.svelte.js';
	import { AssistantMessage } from '$shared/chat-types';
	import type { ChatQueueState } from '$shared/queue-state';
	import { composerQuestion, composerQuestionKey } from '$lib/chat/composer/composer-question.js';

	interface ConversationWorkspaceEscapeHostProps {
		composerStatusBarGitProjects?: boolean;
		executionPolicy?: 'conversation' | 'literal' | null;
		onRegisterSubmit?: (submit: (message: string) => Promise<boolean>) => void;
		onRegisterAppendToDraft?: (append: ChatDraftAppend) => void;
		onPatchActivity?: (chatId: string, timestamp: string) => void;
		fetchProjectResolution?: ConstructorParameters<typeof ProjectResolutionStore>[0];
		commit?: CommitController;
		quickSummary?: GitQuickSummaryStore;
		onOpenCommit?: WorkspaceCoordinator['openSingletonAsTab'];
		notifications?: ReturnType<typeof createNotificationsStore>;
	}

	let {
		composerStatusBarGitProjects = false,
		executionPolicy = 'conversation',
		onRegisterSubmit,
		onRegisterAppendToDraft,
		onPatchActivity,
		fetchProjectResolution,
		commit,
		quickSummary,
		onOpenCommit,
		notifications,
	}: ConversationWorkspaceEscapeHostProps = $props();

	let selectedChat = $state<ChatSessionRecord>({
		id: 'chat-1',
		parentChat: null,
		projectPath: '/workspace/project',
		orderGroup: 'normal',
		title: 'Running chat',
		agentId: 'claude',
		model: 'sonnet',
		permissionMode: 'default',
		thinkingMode: 'none',
		agentSettings: { ownerId: 'claude', schemaVersion: 1, values: {} },
		createdAt: '2026-01-01T00:00:00.000Z',
		lastActivityAt: '2026-01-01T00:00:00.000Z',
		lastReadAt: null,
		isPinned: false,
		isArchived: false,
		isProcessing: true,
		processingPhase: 'running',
		isUnread: false,
		canReloadFromNativeHistory: false,
		status: 'running',
		agentOwnershipEpoch: 'epoch-1',
		tags: [],
	});
	let selectedChatExists = $state(true);
	const chatDrafts = new ChatDraftStore();
	setChatDrafts(chatDrafts);
	setAsyncQuestionController(new AsyncQuestionController());
	const gitDeps = createGitSurfaceTestDeps();
	const singletonSurfaces = new SingletonSurfaceRegistry({
		...unusedSingletonFactories,
		...gitDeps,
		createCommit: () => commit ?? new CommitController(gitDeps),
		createPullRequests: () => new PullRequestsStore({ reviews: new PullRequestReviewsStore() }),
	});
	setSingletonSurfaces(singletonSurfaces);
	onDestroy(() => singletonSurfaces.destroy());
	function getInitialProjectResolver() {
		return (
			fetchProjectResolution ??
			(async (target) => ({
				target,
				resolution: { kind: 'available' as const, effectiveProjectKey: target.projectPath },
			}))
		);
	}
	const projectResolution = new ProjectResolutionStore(getInitialProjectResolver());
	setProjectResolution(projectResolution);
	onDestroy(() => projectResolution.destroy());
	const conversationUi = new ConversationUiState();
	setConversationUi(conversationUi);

	const sessions = {
		get selectedChatId() {
			return selectedChat.id;
		},
		get selectedChat() {
			return selectedChat;
		},
		get byId() {
			return selectedChatExists ? { [selectedChat.id]: selectedChat } : {};
		},
		get orderedChats() {
			return selectedChatExists ? [selectedChat] : [];
		},
		get order() {
			return selectedChatExists ? [selectedChat.id] : [];
		},
		startupByChatId: {},
		hasChat: (chatId: string) => selectedChatExists && chatId === selectedChat.id,
		isDraft: () => false,
		isChatProcessing: (chatId: string) => chatId === selectedChat.id && selectedChat.isProcessing,
		processingPhase: () => selectedChat.processingPhase,
		patchDraftStartup: () => {},
		patchPreview: () => {},
		patchActivity: (chatId: string, timestamp: string) => onPatchActivity?.(chatId, timestamp),
		patchChat: () => {},
		patchLastReadAt: () => {},
		applyStartEntry: () => {},
		upsertServerChat: () => {},
		removeChat: () => {},
		setSelectedChatId: () => {},
		applyProcessingEvent: () => {},
		reconcileProcessing: () => {},
		quietRefreshChats: () => Promise.resolve(),
	};

	setChatSessions(sessions as never);
	setLocalSettings({
		...COMPOSER_STATUS_BAR_DEFAULTS,
		autoScrollToBottom: true,
		get composerStatusBarGitProjects() {
			return composerStatusBarGitProjects;
		},
		chatMaxWidth: 'default',
	} as never);
	setNotifications(untrack(() => notifications ?? createNotificationsStore()));
	setAppShell({
		isMobile: false,
		requestComposerFocus: () => {},
		openNewChatDialog: () => {},
	} as never);
	setWs({
		messages: [],
		trimOffset: 0,
		trimConsumedMessages: () => {},
		isConnected: false,
		registerCursor: (_cursor: DrainCursor) => () => {},
		addMessageConsumer: () => () => {},
		sendRequest: () => Promise.resolve({}),
	} as never);
	const processingReconciler = {
		addPresentation: () => () => {},
	} satisfies ChatProcessingPresentationRegistry;
	setChatProcessingReconciler(processingReconciler);
	setReadReceiptOutbox({
		enqueue: () => {},
	} as never);
	setRemoteSettings({} as never);
	setModelCatalog({
		isValidated: true,
		getAgent: (id: string): AgentMetadata | null => executionPolicy === null ? null : ({
			selectionLabel: 'Model',
			inputFormatByModel: {},
			id, label: id, executionPolicy, defaultModel: 'sonnet',
			supportsCompact: false, supportsFork: true, supportsForkAtMessage: true,
			supportsForkWhileRunning: true, supportsUpdateProjectPath: true, supportsSteering: true,
			supportsImages: false, fileAttachmentMimeTypes: [], acceptsApiProviderEndpoints: false,
			supportedProtocols: [], authLoginSupported: false, supportedPermissionModes: [],
			supportedThinkingModes: [], settings: [], defaultSettings: { ownerId: id, schemaVersion: 1, values: {} },
		}),
		forExecutor() {
			return this;
		},
		selectionValueFor: (_agentId: string, model: string) => model,
		selectionFor: (_agentId: string, model: string) => ({
			model,
			apiProviderId: null,
			modelEndpointId: null,
			modelProtocol: null,
		}),
		isLocalModel: () => false,
		getAgentLabel: (agentId: string) => agentId,
		getDefaultAgentSettings: (agentId: string) => ({
			ownerId: agentId,
			schemaVersion: 1,
			values: {},
		}),
		getPermissionModes: () => ['default', 'acceptEdits', 'manualBypass', 'bypassPermissions'],
		getThinkingModes: () => ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
		supportsFork: () => true,
		supportsForkWhileRunning: () => true,
		supportsSteering: (agentId: string) => agentId === 'claude' || agentId === 'codex',
	} as never);

	const workspaceInteractionGate = new WorkspaceInteractionGate();
	const transientLayers = new TransientLayerRegistry(workspaceInteractionGate);
	type WorkspaceTestPort = WorkspaceShortcutDeps['workspace'] &
		Pick<
			WorkspaceCoordinator,
			| 'currentWindowId'
			| 'currentChatSurfaceId'
			| 'composerAnchorSurfaceId'
			| 'focusChat'
			| 'focusMobileSingleton'
			| 'openSingletonAsTab'
			| 'windowOf'
			| 'focusOwnerRevision'
		>;
	let workspaceFocusOwner = $state<FocusOwner>({
		kind: 'surface',
		surfaceId: CANONICAL_CHAT_SURFACE_ID,
	});
	let workspaceFocusOwnerRevision = $state(0);
	const workspace: WorkspaceTestPort = {
		get focusOwner() {
			return workspaceFocusOwner;
		},
		set focusOwner(owner: FocusOwner) {
			if (sameFocusOwner(workspaceFocusOwner, owner)) return;
			workspaceFocusOwner = owner;
			workspaceFocusOwnerRevision += 1;
		},
		get focusOwnerRevision() {
			return workspaceFocusOwnerRevision;
		},
		isSurfacePresented: (surfaceId: string) => surfaceId === CANONICAL_CHAT_SURFACE_ID,
		focusPreviousTabInFocusedWindow: () => false,
		focusNextTabInFocusedWindow: () => false,
		cycleWindowFocus: () => undefined,
		toggleWindowFullscreen: async () => undefined,
		isMobile: false,
		layout: {
			surface: (surfaceId: string) =>
				surfaceId === CANONICAL_CHAT_SURFACE_ID
					? { id: CANONICAL_CHAT_SURFACE_ID, type: 'chat' as const, chatId: 'chat-1' }
					: null,
		},
		get currentWindowId() {
			return 'window-main' as const;
		},
		get currentChatSurfaceId() {
			return CANONICAL_CHAT_SURFACE_ID;
		},
		get composerAnchorSurfaceId() {
			return CANONICAL_CHAT_SURFACE_ID;
		},
		focusChat: () => Promise.resolve(),
		focusMobileSingleton: () => Promise.resolve(),
		openSingletonAsTab: (...args) => onOpenCommit?.(...args) ?? Promise.resolve(),
		windowOf: () => 'window-main',
	};
	const workspaceShortcuts = new WorkspaceShortcutDispatcher({
		workspace,
		transients: transientLayers,
		appShell: {} as never,
		navigation: {} as never,
		commands: { execute: async () => false, isEnabled: () => false },
		localSettings: { globalShortcuts: {} } as never,
		onError: () => undefined,
	});
	setWorkspaceCoordinator(workspace as WorkspaceCoordinator);
	setWorkspaceShortcuts(workspaceShortcuts);
	setTransientLayers(transientLayers);
	function getQuickSummary(): GitQuickSummaryStore {
		return quickSummary ?? new GitQuickSummaryStore();
	}
	setGitQuickSummary(getQuickSummary());
	const quickGitBranches = new GitBranchSelectorState();
	setGitBranchActions(quickGitBranches);
	const conversationLifecycles = new ConversationLifecycleRegistry({
		sessions,
		processing: processingReconciler,
		conversationUi,
	});
	setConversationLifecycles(conversationLifecycles);
	const conversationPanels = new ConversationPanelRegistry({
		cache: new ChatTranscriptCache({ limit: 100 }),
		lifecycle: conversationLifecycles,
		overlays: new ConversationTranscriptOverlayStore(),
		getComposerAnchorSurfaceId: () => workspace.composerAnchorSurfaceId,
		getSelectedChatId: () => sessions.selectedChatId,
	});
	conversationPanels.reconcile([
		{
			surfaceId: CANONICAL_CHAT_SURFACE_ID,
			chatId: 'chat-1',
			snapshotAdmission: 'admitted',
			presentation: 'window-main',
			windowId: 'window-main',
		},
	]);
	setConversationPanels(conversationPanels);
	const conversationPanel = conversationPanels.panel(CANONICAL_CHAT_SURFACE_ID)!;

	const subagentToolbar = new SubagentToolbarState();
	let panelActions = $state.raw<ConversationPanelActions | null>(null);
	let branchAction = Promise.resolve();
	let showTestLayer = $state(false);
	let testLayerIsComposerEditor = $state(false);
	let testLayerElement = $state<HTMLElement | null>(null);
	$effect(() => {
		if (!showTestLayer || !testLayerElement) return;
		return transientLayers.register({
			id: 'test-dialog',
			kind: 'application-dialog',
			modality: 'main-inert',
			isOpen: () => true,
			element: () => testLayerElement,
			onEscape: () => {
				showTestLayer = false;
				return true;
			},
			restoreFocus: () => {},
		});
	});

	function startBranchToggle(): void {
		branchAction =
			panelActions?.toggleBranch(CANONICAL_CHAT_SURFACE_ID, selectedChat.id) ?? Promise.resolve();
	}

	export async function waitForBranchAction(): Promise<void> {
		await branchAction;
		await tick();
	}

	export async function seedChoice(
		content = 'Which action do you prefer?\n- /clear\n- Keep the conversation',
		viewId = 'gen-choices',
	): Promise<string> {
		selectedChat.isProcessing = false;
		selectedChat.processingPhase = null;
		conversationPanel.transcript.replaceGeneration(
			selectedChat.id,
			viewId,
			[{ ordinal: 1, message: new AssistantMessage('2026-01-01T00:00:00.000Z', content) }],
			{ lastOrdinal: 1, pageOldestOrdinal: 1, nextBeforeOrdinal: null, hasMore: false },
		);
		await tick();
		const question = composerQuestion(conversationPanel.transcript.entries, [], {
			isProcessing: false,
			hasLaterMessages: false,
		});
		if (!question) throw new Error('Expected a synthetic composer question');
		return composerQuestionKey(question, selectedChat.id, viewId);
	}

	export async function answerChoice(answer: string, viewId = 'gen-choices'): Promise<boolean> {
		if (!panelActions) throw new Error('Expected registered conversation panel actions');
		const question = composerQuestion(conversationPanel.transcript.entries, [], {
			isProcessing: false, hasLaterMessages: false,
		});
		if (question?.kind !== 'plain') return false;
		const prompt = question.questions[0];
		const option = prompt.options.find(option => option.label === answer);
		if (!option) return false;
		return panelActions.answerChoice(CANONICAL_CHAT_SURFACE_ID, selectedChat.id, viewId,
			composerQuestionKey(question, selectedChat.id, viewId),
			[{ questionId: prompt.id, selectedOptionIds: [option.id] }]);
	}

	export async function answerChoices(
		answers: import('$lib/chat/composer/response-choices.js').ResponseChoiceAnswer[],
	): Promise<boolean> {
		if (!panelActions) throw new Error('Expected registered conversation panel actions');
		const question = composerQuestion(conversationPanel.transcript.entries, [], {
			isProcessing: false, hasLaterMessages: false,
		});
		if (question?.kind !== 'plain') return false;
		return panelActions.answerChoice(CANONICAL_CHAT_SURFACE_ID, selectedChat.id, 'gen-choices',
			composerQuestionKey(question, selectedChat.id, 'gen-choices'), answers);
	}

	export function choiceStatus(key: string) {
		return panelActions?.choiceStatus(key);
	}

	export function setChoiceDraft(text: string, attachments: File[]): void {
		chatDrafts.setText(selectedChat.id, text);
		chatDrafts.setAttachments(selectedChat.id, attachments);
	}

	export function choiceDraft() {
		return chatDrafts.snapshot(selectedChat.id);
	}

	export function changeChoiceTarget(viewId: string, ownerEpoch: string): void {
		conversationPanel.transcript.transcriptViewId = viewId;
		selectedChat.agentOwnershipEpoch = ownerEpoch;
	}

	export function setChoiceQueue(queue: ChatQueueState): void {
		conversationUi.setExecutionControlFromLiveUpdate(selectedChat.id, {
			serverInstanceId: 'server-instance-test',
			queue,
			version: 100,
			updatedAt: null,
		});
	}

	export function choiceCleanupTargets() {
		return { conversationUi, transcript: conversationPanel.transcript };
	}

	export function deleteChoiceChat(): void {
		selectedChatExists = false;
	}
</script>

<KeyboardShortcuts />
<button
	type="button"
	onclick={() => {
		testLayerIsComposerEditor = false;
		showTestLayer = true;
	}}>Open test layer</button
>
<button
	type="button"
	onclick={() => {
		testLayerIsComposerEditor = true;
		showTestLayer = true;
	}}>Open composer editor layer</button
>
<button type="button" onclick={() => (selectedChat.agentId = 'claude')}>Use Claude</button>
<button type="button" onclick={() => (selectedChat.agentId = 'codex')}>Use Codex</button>
<button type="button" onclick={() => (selectedChat.agentId = 'opencode')}
	>Use unsupported agent</button
>
<button
	type="button"
	onclick={() => {
		selectedChat.isProcessing = !selectedChat.isProcessing;
		selectedChat.processingPhase = selectedChat.isProcessing ? 'running' : null;
	}}>Toggle processing</button
>
<button type="button" onclick={() => (selectedChat.status = 'draft')}>Set draft status</button>
<button type="button" onclick={startBranchToggle}>Open branch dropdown</button>
<button
	type="button"
	onclick={() => panelActions?.openCommit(CANONICAL_CHAT_SURFACE_ID, selectedChat.id)}
	>Open quick commit</button
>
<button type="button" onclick={() => (workspace.focusOwner = { kind: 'chat-list' })}
	>Move command ownership</button
>
<button
	type="button"
	onclick={() => (workspace.focusOwner = { kind: 'surface', surfaceId: CANONICAL_CHAT_SURFACE_ID })}
	>Restore command ownership</button
>
<button
	type="button"
	onclick={() => (workspace.focusOwner = { kind: 'surface', surfaceId: CANONICAL_CHAT_SURFACE_ID })}
	>Refocus command surface</button
>
<div data-testid="branch-dropdown-open">{quickGitBranches.showBranchDropdown}</div>
<div data-testid="new-branch-dialog-open">{quickGitBranches.showNewBranchModal}</div>
<GitBranchSelector
	currentBranch={quickGitBranches.currentBranch}
	refs={quickGitBranches.refs}
	sort={quickGitBranches.branchSort}
	isOpen={quickGitBranches.showBranchDropdown}
	isLoading={quickGitBranches.isLoadingBranches}
	onToggle={startBranchToggle}
	onClose={() => panelActions?.closeBranch(CANONICAL_CHAT_SURFACE_ID, selectedChat.id)}
	onCreateBranch={() => panelActions?.createBranch(CANONICAL_CHAT_SURFACE_ID, selectedChat.id)}
	onSwitchBranch={(branch) =>
		panelActions?.switchBranch(CANONICAL_CHAT_SURFACE_ID, selectedChat.id, branch)}
	onSortRefs={(key, query) =>
		panelActions?.sortBranches(CANONICAL_CHAT_SURFACE_ID, selectedChat.id, key, query)}
/>
{#if showTestLayer}
	<div
		bind:this={testLayerElement}
		role="dialog"
		tabindex="-1"
		aria-label="Test dialog"
		data-workspace-surface-id={testLayerIsComposerEditor ? CANONICAL_CHAT_SURFACE_ID : undefined}
		data-prompt-editor-dialog={testLayerIsComposerEditor ? '' : undefined}
	>
		{#if testLayerIsComposerEditor}
			<button type="button" aria-label="Composer editor chrome">Editor chrome</button>
		{/if}
	</div>
{/if}
<ConversationWorkspace
	{onRegisterSubmit}
	{onRegisterAppendToDraft}
	isVisible={!showTestLayer}
	isPresented={true}
	{subagentToolbar}
	onRegisterPanelActions={(actions) => (panelActions = actions)}
/>
<ConversationPanel
	surfaceId={CANONICAL_CHAT_SURFACE_ID}
	chat={selectedChat}
	panel={conversationPanel}
	isCommandOwner={true}
	ownsComposer={true}
	actions={null}
/>
