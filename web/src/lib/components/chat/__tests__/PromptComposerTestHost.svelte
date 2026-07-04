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
	} from '$lib/context';
	import { AgentState } from '$lib/chat/agent-state.svelte';
	import { ComposerState } from '$lib/chat/composer.svelte';
	import { AppShellStore } from '$lib/stores/app-shell.svelte';
	import { ChatLifecycleStore } from '$lib/stores/chat-lifecycle.svelte';
	import type { ChatSessionRecord, ChatStatus } from '$lib/types/chat-session';
	import type { ModelCatalogStore, ModelOption } from '$lib/stores/model-catalog.svelte';
	import type { GitQuickSummaryReady } from '$lib/api/git.js';

	interface Props {
		selectedChatId?: string;
		selectedAgentId?: ChatSessionRecord['agentId'];
		selectedStatus?: ChatStatus;
		selectedIsProcessing?: boolean;
		isSubmitting?: boolean;
		isVisible?: boolean;
		focusRequestToken?: number;
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
	const modelOptions: ModelOption[] = [{ value: 'opus', label: 'Opus', supportsImages: true }];

	const selectedChat = $derived<ChatSessionRecord>({
		id: selectedChatId,
		projectPath: '/workspace/project',
		title: selectedChatId,
		agentId: selectedAgentId,
		model: 'opus',
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
		getSelectableAgents: () => ['claude'],
		getAgent: () => ({
			id: 'claude',
			label: 'Claude',
				description: '',
				supportsFork: true,
				supportsUpdateProjectPath: true,
				supportsImages: true,
			acceptsApiProviderEndpoints: true,
			supportedProtocols: ['anthropic-messages'],
			defaultModel: 'opus',
		}),
		getAgentLabel: () => 'Claude',
		getModels: () => modelOptions,
		getDefaultModel: () => 'opus',
		getModelForSelection: (_agentId: string, model: string) =>
			modelOptions.find((option) => option.value === model) ?? null,
		supportsImages: () => true,
		supportsFork: (agentId: string) => agentId !== 'amp',
		supportsForkWhileRunning: () => true,
		selectionFor: (_agentId: string, model: string) => ({
			model,
			apiProviderId: null,
			modelEndpointId: null,
			modelProtocol: null,
		}),
		selectionValueFor: (_agentId: string, model: string) => model,
		findEndpoint: () => null,
		refreshIfStale: () => Promise.resolve(),
	} as unknown as ModelCatalogStore);
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
