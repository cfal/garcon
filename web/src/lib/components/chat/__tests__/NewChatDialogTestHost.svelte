<script lang="ts">
	import NewChatDialog from '../NewChatDialog.svelte';
	import {
		setAppShell,
		setChatSessions,
		setLocalSettings,
		setModelCatalog,
		setNotifications,
		setRemoteSettings,
		setSnippets,
		setTransientLayers,
		setWorkspaceCoordinator,
	} from '$lib/context';
	import { WorkspaceInteractionGate } from '$lib/workspace/workspace-interaction-gate.svelte.js';
	import { TransientLayerRegistry } from '$lib/workspace/transient-layers.svelte.js';
	import { createAppShellStore } from '$lib/stores/app-shell.svelte';
	import { createRemoteSettingsStore } from '$lib/stores/remote-settings.svelte';
	import { createNotificationsStore } from '$lib/stores/notifications.svelte.js';
	import { createSnippetsStore } from '$lib/snippets/snippets-store.svelte.js';
	import { setCanonicalWorkspaceLayout } from './workspace-layout-test-context.js';

	interface Props {
		snippetTemplate?: string | null;
		onCreateDraft?: (draft: unknown) => void;
	}

	let { snippetTemplate = null, onCreateDraft = () => {} }: Props = $props();

	const appShell = createAppShellStore();
	setCanonicalWorkspaceLayout();
	appShell.projectBasePath = '/workspace';
	appShell.openNewChatDialog();

	setAppShell(appShell);
	setLocalSettings({
		sendByShiftEnter: false,
		showQuickCommitTray: true,
	} as never);
	setRemoteSettings(createRemoteSettingsStore());
	setNotifications(createNotificationsStore());
	const transientLayers = new TransientLayerRegistry(new WorkspaceInteractionGate());
	setTransientLayers(transientLayers);
	setSnippets(
		createSnippetsStore({
			get: async () => ({
				revision: 0,
				snippets: snippetTemplate
					? [
							{
								id: 'snippet-handoff',
								shortName: 'handoff',
								template: snippetTemplate,
								defaultArguments: '',
								createdAt: '2026-01-01T00:00:00.000Z',
								updatedAt: '2026-01-01T00:00:00.000Z',
							},
						]
					: [],
			}),
		}),
	);
	setChatSessions({
		orderedChats: [],
		createDraft(draft: unknown) {
			onCreateDraft(draft);
		},
	} as never);
	setWorkspaceCoordinator({
		focusChat: () => Promise.resolve(),
	} as never);
	setModelCatalog({
		version: 0,
		agentMetadata: {
			claude: { label: 'Claude' },
		},
		getAgents() {
			return ['claude'];
		},
		getSelectableAgents() {
			return ['claude'];
		},
		getAgent(agentId: string) {
			return {
				id: agentId,
				label: 'Claude',
				description: '',
				supportsFork: true,
				supportsUpdateProjectPath: true,
				supportsImages: true,
				acceptsApiProviderEndpoints: true,
				supportedProtocols: ['anthropic-messages'],
				defaultModel: 'opus',
			};
		},
		getAgentLabel() {
			return 'Claude';
		},
		getDefaultModel() {
			return 'opus';
		},
		getPermissionModes() {
			return ['default', 'acceptEdits', 'manualBypass', 'bypassPermissions', 'plan'];
		},
		getThinkingModes() {
			return ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
		},
		getAgentSettingsDescriptors() {
			return [];
		},
		getDefaultAgentSettings() {
			return { ownerId: 'claude', schemaVersion: 1, values: {} };
		},
		getModels() {
			return [{ value: 'opus', label: 'Opus' }];
		},
		supportsImages() {
			return true;
		},
		getModelForSelection(_agentId: string, model: string) {
			return model === 'opus' ? { value: 'opus', label: 'Opus' } : null;
		},
		selectionFor(_agentId: string, model: string) {
			return {
				model,
				apiProviderId: null,
				modelEndpointId: null,
				modelProtocol: null,
			};
		},
		selectionValueFor(_agentId: string, model: string) {
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
<NewChatDialog />
