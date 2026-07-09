<script lang="ts">
	import PromptComposer from '../PromptComposer.svelte';
	import {
		setAgentState,
		setAppShell,
		setChatLifecycle,
		setChatSessions,
		setComposerState,
		setLocalSettings,
		setModelCatalog,
		setRemoteSettings,
	} from '$lib/context';
	import { AgentState } from '$lib/chat/agent-state.svelte';
	import { ComposerState } from '$lib/chat/composer.svelte';
	import { AppShellStore } from '$lib/stores/app-shell.svelte';
	import { ChatLifecycleStore } from '$lib/stores/chat-lifecycle.svelte';
	import type { ChatSessionRecord, ChatStatus } from '$lib/types/chat-session';
	import type { SessionAgentId } from '$lib/types/app';
	import type { ModelCatalogStore, ModelOption } from '$lib/stores/model-catalog.svelte';
	import type { GitQuickSummaryReady } from '$lib/api/git.js';
	import type { RecentAgentSetting, RemoteSettingsSnapshot } from '$shared/settings';

	interface Props {
		selectedChatId?: string;
		selectedAgentId?: SessionAgentId;
		selectedStatus?: ChatStatus;
		selectedIsProcessing?: boolean;
		isSubmitting?: boolean;
		isVisible?: boolean;
		focusRequestToken?: number;
		selectableAgents?: SessionAgentId[];
		recentAgentSettings?: RecentAgentSetting[];
		quickCommitTrayVisible?: boolean;
		quickCommitRefreshing?: boolean;
		quickCommitSummary?: GitQuickSummaryReady | null;
		onsubmit?: () => void;
		onAbort?: () => void;
		onQuickCommit?: () => void;
	}

	let {
		selectedChatId = 'chat-1',
		selectedAgentId = 'claude',
		selectedStatus = 'running',
		selectedIsProcessing = false,
		isSubmitting = false,
		isVisible = true,
		focusRequestToken = 0,
		selectableAgents = ['claude'],
		recentAgentSettings = [],
		quickCommitTrayVisible = false,
		quickCommitRefreshing = false,
		quickCommitSummary = null,
		onsubmit = () => {},
		onAbort = () => {},
		onQuickCommit = () => {},
	}: Props = $props();

	const composer = new ComposerState();
	const agent = new AgentState();
	const lifecycle = new ChatLifecycleStore();
	const appShell = new AppShellStore();
	const modelOptionsByAgent: Record<string, ModelOption[]> = {
		claude: [{ value: 'opus', label: 'Opus', supportsImages: true }],
		codex: [{ value: 'gpt-5', label: 'GPT-5', supportsImages: true }],
		amp: [{ value: 'amp-smart', label: 'Amp Smart', supportsImages: true }],
	};
	const agentLabels: Record<string, string> = {
		claude: 'Claude',
		codex: 'Codex',
		amp: 'Amp',
	};
	const selectedModel = $derived(modelOptionsFor(selectedAgentId)[0]?.value ?? 'opus');
	const remoteSettingsSnapshot = $derived<RemoteSettingsSnapshot>({
		version: 1,
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
				claudeThinkingMode: 'auto',
				ampAgentMode: 'smart',
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
		return agentLabels[agentId] ?? agentId;
	}

	function modelOptionsFor(agentId: string): ModelOption[] {
		return modelOptionsByAgent[agentId] ?? [];
	}

	function modelForSelection(agentId: string, model: string): ModelOption | null {
		return modelOptionsFor(agentId).find((option) => option.value === model) ?? null;
	}

	const selectedChat = $derived<ChatSessionRecord>({
		id: selectedChatId,
		projectPath: '/workspace/project',
		title: selectedChatId,
		agentId: selectedAgentId,
		model: selectedModel,
		permissionMode: 'default',
		thinkingMode: 'none',
		claudeThinkingMode: 'auto',
		ampAgentMode: 'smart',
		createdAt: '2026-01-01T00:00:00.000Z',
		lastActivityAt: '2026-01-01T00:00:00.000Z',
		lastReadAt: '2026-01-01T00:00:00.000Z',
		isPinned: false,
		isArchived: false,
		isProcessing: selectedIsProcessing,
		isUnread: false,
		status: selectedStatus,
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
	setAgentState(agent);
	setChatLifecycle(lifecycle);
	setAppShell(appShell);
	setLocalSettings({
		sendByShiftEnter: false,
		showQuickCommitTray: true,
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
		getModelForSelection: modelForSelection,
		supportsImages: (agentId: string, model: string) =>
			modelForSelection(agentId, model)?.supportsImages ?? true,
		supportsFork: (agentId: string) => agentId !== 'amp',
		supportsForkWhileRunning: () => true,
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
</script>

<PromptComposer
	{onsubmit}
	{isVisible}
	{quickCommitTrayVisible}
	{quickCommitRefreshing}
	{quickCommitSummary}
	{onAbort}
	{onQuickCommit}
/>
