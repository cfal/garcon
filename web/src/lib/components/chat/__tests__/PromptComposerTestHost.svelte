<script lang="ts">
	import PromptComposer from '../PromptComposer.svelte';
	import { onDestroy } from 'svelte';
	import {
		setAgentState,
		setActiveTranscriptState,
		setAppShell,
		setConversationLifecycle,
		setChatSessions,
		setComposerState,
		setLocalSettings,
		setModelCatalog,
		setNotifications,
		setRemoteSettings,
		setSnippets,
		setTransientLayers,
		setWorkspaceShortcuts,
		setChatDrafts,
	} from '$lib/context';
	import { AgentState } from '$lib/chat/conversation/agent-state.svelte.js';
	import { ActiveTranscriptState } from '$lib/chat/transcript/active-transcript-state.svelte.js';
	import { ComposerState } from '$lib/chat/composer/composer.svelte.js';
	import { ChatDraftStore } from '$lib/chat/composer/chat-draft-store.svelte.js';
	import { AppShellStore } from '$lib/stores/app-shell.svelte';
	import { ConversationLifecycleState } from '$lib/chat/conversation/conversation-lifecycle-state.svelte.js';
	import type { ChatSessionRecord, ChatStatus } from '$lib/types/chat-session';
	import type { SessionAgentId } from '$lib/types/app';
	import type { ModelCatalogStore, ModelOption } from '$lib/agents/model-catalog-store.svelte';
	import type { GitQuickSummaryReady } from '$lib/api/git.js';
	import type { RecentAgentSetting, RemoteSettingsSnapshot } from '$shared/settings';
	import { WorkspaceInteractionGate } from '$lib/workspace/workspace-interaction-gate.svelte';
	import KeyboardShortcuts from '$lib/components/shared/KeyboardShortcuts.svelte';
	import { TransientLayerRegistry } from '$lib/workspace/transient-layers.svelte';
	import { createSnippetsStore } from '$lib/snippets/snippets-store.svelte.js';
	import { createNotificationsStore } from '$lib/stores/notifications.svelte.js';
	import { agentLabelFor } from '$lib/agents/agent-labels.js';
	import {
		DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID,
		DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID,
		DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID,
	} from '$shared/agents';
	import {
		WorkspaceShortcutDispatcher,
		type WorkspaceShortcutDeps,
	} from '$lib/workspace/workspace-shortcuts.js';
	import { CANONICAL_CHAT_SURFACE_ID } from '$lib/workspace/canonical-layout.js';
	import { setCanonicalWorkspaceLayout } from './workspace-layout-test-context.js';

	interface Props {
		selectedChatId?: string;
		projectPath?: string;
		selectedAgentId?: SessionAgentId;
		selectedStatus?: ChatStatus;
		selectedIsProcessing?: boolean;
		isSubmitting?: boolean;
		isVisible?: boolean;
		isPresented?: boolean;
		focusRequestToken?: number;
		composerEditorOpenRequestId?: number;
		selectableAgents?: SessionAgentId[];
		recentAgentSettings?: RecentAgentSetting[];
		allowDirectChats?: boolean;
		reduceMotion?: boolean;
		steerWithCtrlEnter?: boolean;
		snippetTrigger?: string;
		snippetTemplate?: string;
		snippetDefaultArguments?: string;
		quickCommitTrayVisible?: boolean;
		quickCommitRefreshing?: boolean;
		quickCommitSummary?: GitQuickSummaryReady | null;
		directAdmissionPending?: boolean;
		onsubmit?: () => void;
		onSteerPreferredSubmit?: () => void;
		onAbort?: () => void;
		onQuickCommit?: () => void;
	}

	let {
		selectedChatId = 'chat-1',
		projectPath = '/workspace/project',
		selectedAgentId = 'claude',
		selectedStatus = 'running',
		selectedIsProcessing = false,
		isSubmitting = false,
		isVisible = true,
		isPresented,
		focusRequestToken = 0,
		composerEditorOpenRequestId = 0,
		selectableAgents = ['claude'],
		recentAgentSettings = [],
		allowDirectChats = false,
		reduceMotion = false,
		steerWithCtrlEnter = true,
		snippetTrigger = ';;',
		snippetTemplate = 'Review {{arguments}} in {{project_path}}',
		snippetDefaultArguments = '',
		quickCommitTrayVisible = false,
		quickCommitRefreshing = false,
		quickCommitSummary = null,
		directAdmissionPending = false,
		onsubmit = () => {},
		onSteerPreferredSubmit = () => {},
		onAbort = () => {},
		onQuickCommit = () => {},
	}: Props = $props();

	const chatDrafts = new ChatDraftStore();
	const composer = new ComposerState(chatDrafts, {
		get activeChatId() {
			return selectedChatId;
		},
	});
	const transcript = new ActiveTranscriptState();

	export function getComposerContentRevision(): number {
		return composer.contentRevision;
	}
	const agent = new AgentState();
	const lifecycle = new ConversationLifecycleState();
	const appShell = new AppShellStore();
	const notifications = createNotificationsStore();
	let snippetLoadCount = $state(0);
	const modelOptionsByAgent: Record<string, ModelOption[]> = {
		claude: [{ value: 'opus', label: 'Opus', supportsImages: true }],
		codex: [{ value: 'gpt-5', label: 'GPT-5', supportsImages: true }],
		amp: [{ value: 'amp-smart', label: 'Amp Smart', supportsImages: true }],
		[DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID]: [
			{ value: 'chat-model', label: 'Chat Model', supportsImages: true },
		],
		[DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID]: [
			{ value: 'responses-model', label: 'Responses Model', supportsImages: true },
		],
		[DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID]: [
			{ value: 'anthropic-model', label: 'Anthropic Model', supportsImages: true },
		],
	};
	const agentLabels: Record<string, string> = {
		claude: 'Claude',
		codex: 'Codex',
		amp: 'Amp',
	};
	const selectedModel = $derived(modelOptionsFor(selectedAgentId)[0]?.value ?? 'opus');
	const remoteSettingsSnapshot = $derived<RemoteSettingsSnapshot>({
		version: 1,
		features: {
			transcriptSearch: { enabled: false },
			agentCommands: { enabled: true, chatIdDiscovery: true, sendMessage: true },
		},
		ui: {},
		uiEffective: {},
		paths: {
			pinnedProjectPaths: [],
			browseStartPath: '/workspace',
			recentProjectPaths: [],
		},
		pinnedChatIds: [],
		recentAgentSettings,
		executionDefaults: {
			global: {
				permissionMode: 'default',
				thinkingMode: 'none',
				agentSettingsById: {},
			},
			byAgent: {},
		},
		projectBasePath: '/workspace',
		telegram: {
			botTokenAvailable: false,
			botUsername: null,
			botFirstName: null,
			recipientUsername: null,
			recipientDisplayName: null,
			recipientLinked: false,
			pendingLink: false,
			linkUrl: null,
		},
	});

	function labelForAgent(agentId: string): string {
		return agentLabelFor(agentId, agentLabels[agentId] ?? agentId);
	}

	function modelOptionsFor(agentId: string): ModelOption[] {
		return modelOptionsByAgent[agentId] ?? [];
	}

	function modelForSelection(agentId: string, model: string): ModelOption | null {
		return modelOptionsFor(agentId).find((option) => option.value === model) ?? null;
	}

	const selectedChat = $derived<ChatSessionRecord>({
		id: selectedChatId,
		projectPath,
		effectiveProjectKey: projectPath,
		projectIdentityState: 'available',
		orderGroup: 'normal',
		title: selectedChatId,
		agentId: selectedAgentId,
		model: selectedModel,
		permissionMode: 'default',
		thinkingMode: 'none',
		agentSettings: { ownerId: 'claude', schemaVersion: 1, values: {} },
		createdAt: '2026-01-01T00:00:00.000Z',
		lastActivityAt: '2026-01-01T00:00:00.000Z',
		lastReadAt: '2026-01-01T00:00:00.000Z',
		isPinned: false,
		isArchived: false,
		isProcessing: selectedIsProcessing,
		processingPhase: selectedIsProcessing ? 'running' : null,
		isUnread: false,
		canReloadFromNativeHistory: false,
		status: selectedStatus,
		agentOwnershipEpoch: selectedStatus === 'draft' ? null : 'epoch-1',
		tags: [],
	});

	$effect(() => {
		composer.isSubmitting = isSubmitting;
	});

	$effect(() => {
		agent.setAgentId(selectedAgentId);
		agent.setModelSelection({
			model: selectedModel,
			apiProviderId: null,
			modelEndpointId: null,
			modelProtocol: null,
		});
	});

	$effect(() => {
		const token = focusRequestToken;
		if (token > 0) appShell.requestComposerFocus();
	});

	setComposerState(composer);
	setChatDrafts(chatDrafts);
	setActiveTranscriptState(transcript);
	setAgentState(agent);
	setConversationLifecycle(lifecycle);
	setAppShell(appShell);
	setLocalSettings({
		get sendByShiftEnter() {
			return false;
		},
		get steerWithCtrlEnter() {
			return steerWithCtrlEnter;
		},
		get reduceMotion() {
			return reduceMotion;
		},
		get snippetTrigger() {
			return snippetTrigger;
		},
		get showQuickCommitTray() {
			return true;
		},
		get allowDirectChats() {
			return allowDirectChats;
		},
	} as never);
	setChatSessions({
		get selectedChatId() {
			return selectedChatId;
		},
		get selectedChat() {
			return selectedChat;
		},
		get byId() {
			return { [selectedChatId]: selectedChat };
		},
		startupByChatId: {},
	} as never);
	setModelCatalog({
		version: 0,
		getSelectableAgents: () => selectableAgents,
		getAgent: (agentId: string) => ({
			id: agentId,
			label: labelForAgent(agentId),
			description: '',
			supportsFork: agentId !== 'amp',
			supportsForkAtMessage: agentId !== 'amp',
			supportsForkWhileRunning: agentId !== 'amp',
			supportsSteering: agentId === 'codex',
			supportsGoals: agentId === 'codex',
			supportsUpdateProjectPath: true,
			supportsImages: true,
			acceptsApiProviderEndpoints: true,
			supportedProtocols: ['anthropic-messages', 'openai-compatible'],
			authLoginSupported: false,
			defaultModel: modelOptionsFor(agentId)[0]?.value ?? '',
		}),
		getAgentLabel: labelForAgent,
		getModels: modelOptionsFor,
		getDefaultModel: (agentId: string) => modelOptionsFor(agentId)[0]?.value ?? '',
		getPermissionModes: () => [
			'default',
			'acceptEdits',
			'manualBypass',
			'bypassPermissions',
			'plan',
		],
		getThinkingModes: () => ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
		getAgentSettingsDescriptors: () => [],
		getDefaultAgentSettings: (agentId: string) => ({
			ownerId: agentId,
			schemaVersion: 1,
			values: {},
		}),
		getModelForSelection: modelForSelection,
		supportsImages: (agentId: string, model: string) =>
			modelForSelection(agentId, model)?.supportsImages ?? true,
		supportsFork: (agentId: string) => agentId !== 'amp',
		supportsForkWhileRunning: () => true,
		supportsSteering: (agentId: string) => agentId === 'codex',
		supportsGoals: (agentId: string) => agentId === 'codex',
		selectionFor: (_agentId: string, model: string) => ({
			model,
			apiProviderId: null,
			modelEndpointId: null,
			modelProtocol: null,
		}),
		selectionValueFor: (_agentId: string, model: string) => model,
		isLocalModel: () => false,
		findEndpoint: () => null,
		refreshIfStale: () => Promise.resolve(),
	} as unknown as ModelCatalogStore);
	setRemoteSettings({
		get snapshot() {
			return remoteSettingsSnapshot;
		},
		get hasSnapshot() {
			return true;
		},
		ensureLoaded: () => Promise.resolve(remoteSettingsSnapshot),
		ensureLoadedInBackground: () => Promise.resolve(),
		refreshInBackground: () => Promise.resolve(),
		update: () => Promise.resolve(remoteSettingsSnapshot),
		applySnapshot: () => remoteSettingsSnapshot,
		applyOptimisticSnapshot: () => () => {},
	} as never);
	setNotifications(notifications);
	setSnippets(
		createSnippetsStore({
			get: async () => {
				snippetLoadCount += 1;
				return {
					revision: 1,
					snippets: [
						{
							id: 'snippet-review',
							shortName: 'review',
							template: snippetTemplate,
							defaultArguments: snippetDefaultArguments,
							createdAt: '2026-01-01T00:00:00.000Z',
							updatedAt: '2026-01-01T00:00:00.000Z',
						},
					],
				};
			},
		}),
	);
	const transientLayers = new TransientLayerRegistry(new WorkspaceInteractionGate());
	setTransientLayers(transientLayers);
	setCanonicalWorkspaceLayout();
	onDestroy(() => chatDrafts.destroy());
	const shortcutWorkspace = {
		focusOwner: { kind: 'surface' as const, surfaceId: CANONICAL_CHAT_SURFACE_ID },
		isSurfacePresented: () => true,
		focusPreviousTabInFocusedWindow: () => false,
		focusNextTabInFocusedWindow: () => false,
		cycleWindowFocus: () => undefined,
		layout: {
			surface: () => ({
				id: CANONICAL_CHAT_SURFACE_ID,
				type: 'chat' as const,
				chatId: 'chat-1',
			}),
		},
	} satisfies WorkspaceShortcutDeps['workspace'];
	setWorkspaceShortcuts(
		new WorkspaceShortcutDispatcher({
			workspace: shortcutWorkspace,
			transients: transientLayers,
			appShell,
			navigation: {
				requestNavigateChatAbove: () => undefined,
				requestNavigateChatBelow: () => undefined,
			},
			files: { save: async () => true },
			localSettings: { globalShortcuts: {} },
		}),
	);
</script>

<KeyboardShortcuts />
<PromptComposer
	{onsubmit}
	{onSteerPreferredSubmit}
	{isVisible}
	{isPresented}
	{composerEditorOpenRequestId}
	{quickCommitTrayVisible}
	{quickCommitRefreshing}
	{quickCommitSummary}
	{directAdmissionPending}
	{onAbort}
	{onQuickCommit}
/>

<button
	type="button"
	data-testid="append-draft"
	onclick={() => composer.appendDraftBlock(selectedChatId, 'Appended review block')}
	>Append draft</button
>
<button
	type="button"
	data-testid="clear-draft"
	onclick={() => composer.clearAfterSubmit(selectedChatId)}>Clear draft</button
>

<div data-testid="snippet-load-count">{snippetLoadCount}</div>
<div data-testid="composer-attachment-count">{composer.images.length}</div>
{#each notifications.items as notification (notification.id)}
	<div data-testid="notification">{notification.message}</div>
{/each}
