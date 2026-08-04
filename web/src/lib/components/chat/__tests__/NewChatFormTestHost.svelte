<script lang="ts">
	import NewChatForm from '../NewChatForm.svelte';
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
	import { createSnippetsStore } from '$lib/snippets/snippets-store.svelte.js';
	import { createNotificationsStore } from '$lib/stores/notifications.svelte.js';
	import KeyboardShortcuts from '$lib/components/shared/KeyboardShortcuts.svelte';
	import { ChatInteractionGate } from '$lib/workspace/chat-interaction-gate.svelte';
	import { TransientLayerRegistry } from '$lib/workspace/transient-layers.svelte';
	import { agentLabelFor } from '$lib/agents/agent-labels.js';
	import {
		DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID,
		DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID,
		DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID,
	} from '$shared/agents';

	interface Props {
		allowDirectChats?: boolean;
		snippetTrigger?: string;
		snippetTemplate?: string;
		onStartChat?: (config: NewChatConfig) => void;
	}

	let {
		allowDirectChats = false,
		snippetTrigger = ';;',
		snippetTemplate = 'Review {{arguments}} in {{project_path}}',
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

	const appShell = {
		projectBasePath: '/workspace',
		isMobile: false,
		openSnippets() {},
		onNewChatDialogSeed() {
			return () => {};
		},
	} as never;
	setAppShell(appShell);
	const transientLayers = new TransientLayerRegistry(new ChatInteractionGate());
	setTransientLayers(transientLayers);

	const selectableAgentIds = [
		DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID,
		DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID,
		DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID,
		'claude',
		'codex',
	];

	function modelForAgent(agentId: string): { value: string; label: string } {
		if (agentId === 'claude') return { value: 'opus', label: 'Opus' };
		if (agentId === 'codex') return { value: 'gpt-5.4', label: 'GPT-5.4' };
		if (agentId === DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID) {
			return { value: 'chat-model', label: 'Chat Model' };
		}
		if (agentId === DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID) {
			return { value: 'responses-model', label: 'Responses Model' };
		}
		return { value: 'anthropic-model', label: 'Anthropic Model' };
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
							createdAt: '2026-01-01T00:00:00.000Z',
							updatedAt: '2026-01-01T00:00:00.000Z',
						},
					],
				};
			},
		}),
	);

	setModelCatalog({
		version: 0,
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
				supportsImages: true,
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
			return [modelForAgent(agentId)];
		},
		supportsImages() {
			return true;
		},
		getModelForSelection(agentId: string, model: string) {
			const models = [modelForAgent(agentId)];
			return models.find((entry) => entry.value === model) ?? null;
		},
		selectionFor(_provider: string, model: string) {
			return {
				model,
				apiProviderId: null,
				modelEndpointId: null,
				modelProtocol: null,
			};
		},
		selectionValueFor(_provider: string, model: string) {
			return model;
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

<div data-testid="snippet-load-count">{snippetLoadCount}</div>
{#each notifications.items as notification (notification.id)}
	<div data-testid="notification">{notification.message}</div>
{/each}
