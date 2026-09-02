<script lang="ts">
	import NewChatForm from '../NewChatForm.svelte';
	import { setCanonicalWorkspaceLayout } from './workspace-layout-test-context.js';
	import {
		setAppShell,
		setModelCatalog,
		setLocalSettings,
		setRemoteSettings,
		setChatSessions,
		setNotifications,
		setSnippets,
		setTransientLayers,
	} from '$lib/context';
	import { createRemoteSettingsStore } from '$lib/stores/remote-settings.svelte';
	import type { NewChatConfig } from '$lib/types/app.js';
	import type { ChatId } from '$shared/chat-id';
	import { createSnippetsStore } from '$lib/snippets/snippets-store.svelte.js';
	import { createNotificationsStore } from '$lib/stores/notifications.svelte.js';
	import { WorkspaceInteractionGate } from '$lib/workspace/workspace-interaction-gate.svelte';
	import { TransientLayerRegistry } from '$lib/workspace/transient-layers.svelte';
	import { agentLabelFor } from '$lib/agents/agent-labels.js';
	import {
		DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID,
		DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID,
		DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID,
	} from '$shared/agents';
	import type { ModelOption } from '$lib/agents/model-catalog-store.svelte.js';

	interface Props {
		allowDirectChats?: boolean;
		catalogVersion?: number;
		endpointBackedDirectModel?: boolean;
		modelsAvailable?: boolean;
		supportsImages?: boolean;
		snippetTrigger?: string;
		snippetTemplate?: string;
		snippetDefaultArguments?: string;
		onStartChat?: (config: NewChatConfig, chatId: ChatId) => void;
	}

	let {
		allowDirectChats = false,
		catalogVersion = 0,
		endpointBackedDirectModel = false,
		modelsAvailable = true,
		supportsImages = true,
		snippetTrigger = ';;',
		snippetTemplate = 'Review {{arguments}} in {{project_path}}',
		snippetDefaultArguments = '',
		onStartChat = () => {},
	}: Props = $props();
	const notifications = createNotificationsStore();
	let snippetLoadCount = $state(0);

	setLocalSettings({
		sendByShiftEnter: false,
		showQuickCommitTray: true,
		get snippetTrigger() {
			return snippetTrigger;
		},
		get allowDirectChats() {
			return allowDirectChats;
		},
	} as never);

	setRemoteSettings(createRemoteSettingsStore());

	setChatSessions({
		orderedChats: [],
	} as never);

	setNotifications(notifications);
	setCanonicalWorkspaceLayout();

	let seedListener = () => {};
	const appShell = {
		projectBasePath: '/workspace',
		isMobile: false,
		openSnippets() {},
		onNewChatDialogSeed(callback: () => void) {
			seedListener = callback;
			return () => {};
		},
	} as never;
	setAppShell(appShell);
	const transientLayers = new TransientLayerRegistry(new WorkspaceInteractionGate());
	setTransientLayers(transientLayers);

	const selectableAgentIds = [
		DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID,
		DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID,
		DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID,
		'claude',
		'codex',
	];

	function modelForAgent(agentId: string): ModelOption {
		if (agentId === 'claude') return { value: 'opus', label: 'Opus' };
		if (agentId === 'codex') return { value: 'gpt-5.4', label: 'GPT-5.4' };
		if (agentId === DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID) {
			if (endpointBackedDirectModel) {
				return {
					value: 'test_openai:chat-model',
					label: 'Test: Chat Model',
					rawModel: 'chat-model',
					apiProviderId: 'test-provider',
					endpointId: 'test_openai',
					protocol: 'openai-compatible',
				};
			}
			return { value: 'chat-model', label: 'Chat Model' };
		}
		if (agentId === DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID) {
			return { value: 'responses-model', label: 'Responses Model' };
		}
		return { value: 'anthropic-model', label: 'Anthropic Model' };
	}

	function modelsForAgent(agentId: string): ModelOption[] {
		if (
			agentId === DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID &&
				endpointBackedDirectModel &&
				!modelsAvailable
			) return [];
		return [modelForAgent(agentId)];
	}

	function modelForSelection(
		agentId: string,
		model: string,
		endpointId?: string | null,
	): ModelOption | null {
		const models = modelsForAgent(agentId);
		if (endpointId !== undefined) {
			if (endpointId === null) {
				return (
					models.find(
						(entry) =>
							!entry.endpointId && (entry.value === model || entry.rawModel === model),
					) ?? null
				);
			}
			return (
				models.find(
					(entry) =>
						entry.endpointId === endpointId && (entry.value === model || entry.rawModel === model),
				) ?? null
			);
		}
		return (
			models.find((entry) => entry.value === model) ??
			models.find((entry) => !entry.endpointId && entry.rawModel === model) ??
			null
		);
	}

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

	setModelCatalog({
		get version() {
			return catalogVersion;
		},
		agentMetadata: {
			claude: { label: 'Claude' },
			codex: { label: 'Codex' },
		},
		getAgents() {
			return selectableAgentIds;
		},
		getSelectableAgents() {
			return selectableAgentIds;
		},
		getAgent(agentId: string) {
			return {
				id: agentId,
				label: agentLabelFor(agentId),
				description: '',
				supportsFork: true,
				supportsUpdateProjectPath: true,
				supportsImages,
				acceptsApiProviderEndpoints: true,
				supportedProtocols: agentId === 'codex' ? ['openai-compatible'] : ['anthropic-messages'],
				defaultModel: modelForAgent(agentId).value,
			};
		},
		getAgentLabel(agentId: string) {
			return agentLabelFor(agentId);
		},
		getDefaultModel(agentId: string) {
			return modelForAgent(agentId).value;
		},
		getPermissionModes(agentId: string) {
			return agentId === 'claude'
				? ['default', 'acceptEdits', 'manualBypass', 'bypassPermissions', 'plan']
				: ['default', 'acceptEdits', 'manualBypass', 'bypassPermissions'];
		},
		getThinkingModes() {
			return ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
		},
		getAgentSettingsDescriptors() {
			return [
				{
					key: 'thinking',
					type: 'enum',
					label: 'Thinking',
					labelKey: 'thinking',
					options: [
						{
							value: 'auto',
							label: 'Auto',
							labelKey: 'automatic',
							description: 'Lets Claude decide when extended thinking is useful.',
							descriptionKey: 'thinkingAutomatic',
						},
						{
							value: 'on',
							label: 'On',
							labelKey: 'enabled',
							description: 'Uses extended thinking for every response.',
							descriptionKey: 'thinkingEnabled',
						},
						{
							value: 'off',
							label: 'Off',
							labelKey: 'disabled',
							description: 'Answers without extended thinking.',
							descriptionKey: 'thinkingDisabled',
						},
					],
				},
			];
		},
		getDefaultAgentSettings(agentId: string) {
			return { ownerId: agentId, schemaVersion: 1, values: { thinking: 'auto' } };
		},
		getModels(agentId: string) {
			return modelsForAgent(agentId);
		},
		supportsImages() {
			return supportsImages;
		},
		getModelForSelection(agentId: string, model: string, endpointId?: string | null) {
			return modelForSelection(agentId, model, endpointId);
		},
		selectionFor(agentId: string, model: string, endpointId?: string | null) {
			const selected = modelForSelection(agentId, model, endpointId);
			if (!selected && endpointId) return null;
			return {
				model: selected?.rawModel ?? model,
				apiProviderId: selected?.apiProviderId ?? null,
				modelEndpointId: selected?.endpointId ?? null,
				modelProtocol: selected?.protocol ?? null,
			};
		},
		selectionValueFor(agentId: string, model: string, endpointId?: string | null) {
			return modelForSelection(agentId, model, endpointId)?.value ?? model;
		},
		refreshIfStale() {
			return Promise.resolve();
		},
		findEndpoint() {
			return null;
		},
	} as never);
</script>

<svelte:window onkeydowncapture={(event) => transientLayers.handleEscape(event)} />
<NewChatForm {onStartChat} />

<button type="button" data-testid="reseed-new-chat" onclick={() => seedListener()}>Reseed</button>

<div data-testid="snippet-load-count">{snippetLoadCount}</div>
{#each notifications.items as notification (notification.id)}
	<div data-testid="notification">{notification.message}</div>
{/each}
