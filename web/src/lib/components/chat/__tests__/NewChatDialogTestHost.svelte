<script lang="ts">
	import NewChatDialog from '../NewChatDialog.svelte';
	import {
		setAppShell,
		setChatSessions,
		setLocalSettings,
		setModelCatalog,
		setNavigation,
		setRemoteSettings,
	} from '$lib/context';
	import { createAppShellStore } from '$lib/stores/app-shell.svelte';
	import { createRemoteSettingsStore } from '$lib/stores/remote-settings.svelte';

	const appShell = createAppShellStore();
	appShell.projectBasePath = '/workspace';
	appShell.openNewChatDialog();

	setAppShell(appShell);
	setLocalSettings({
		sendByShiftEnter: false,
	} as never);
	setRemoteSettings(createRemoteSettingsStore());
	setNavigation({
		setActiveTab() {},
	} as never);
	setChatSessions({
		orderedChats: [],
		createDraft() {},
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

<NewChatDialog />
