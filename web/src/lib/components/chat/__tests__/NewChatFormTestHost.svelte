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

	let { onStartChat = () => {} }: { onStartChat?: (config: NewChatConfig) => void } = $props();
	const notifications = createNotificationsStore();
	let snippetLoadCount = $state(0);

	setLocalSettings({
		sendByShiftEnter: false,
		showQuickCommitTray: true,
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
							template: 'Review {{arguments}} in {{project_path}}',
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
			return ['claude', 'codex'];
		},
		getSelectableAgents() {
			return ['claude', 'codex'];
		},
		getAgent(agentId: string) {
			return {
				id: agentId,
				label: agentId === 'codex' ? 'Codex' : 'Claude',
				description: '',
				supportsFork: true,
				supportsUpdateProjectPath: true,
				supportsImages: true,
				acceptsApiProviderEndpoints: true,
				supportedProtocols: agentId === 'codex' ? ['openai-compatible'] : ['anthropic-messages'],
				defaultModel: agentId === 'codex' ? 'gpt-5.4' : 'opus',
			};
		},
		getAgentLabel(agentId: string) {
			return agentId === 'codex' ? 'Codex' : 'Claude';
		},
		getDefaultModel(agentId: string) {
			if (agentId === 'claude') return 'opus';
			if (agentId === 'codex') return 'gpt-5.4';
			return '';
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
			return [];
		},
		getDefaultAgentSettings(agentId: string) {
			return { ownerId: agentId, schemaVersion: 1, values: {} };
		},
		getModels(agentId: string) {
			if (agentId === 'claude') return [{ value: 'opus', label: 'Opus' }];
			if (agentId === 'codex') return [{ value: 'gpt-5.4', label: 'GPT-5.4' }];
			return [];
		},
		supportsImages() {
			return true;
		},
		getModelForSelection(agentId: string, model: string) {
			const models =
				agentId === 'codex'
					? [{ value: 'gpt-5.4', label: 'GPT-5.4' }]
					: [{ value: 'opus', label: 'Opus' }];
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
