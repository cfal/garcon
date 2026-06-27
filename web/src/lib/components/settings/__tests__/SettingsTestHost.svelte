<script lang="ts">
	import Settings from '../Settings.svelte';
	import { setAppShell, setLocalSettings, setModelCatalog, setRemoteSettings } from '$lib/context';
	import type { AppShellStore } from '$lib/stores/app-shell.svelte';
	import type { RemoteSettingsStore } from '$lib/stores/remote-settings.svelte';
	import type { UpdateRemoteSettingsInput } from '$shared/settings';

	interface SettingsTestHostProps {
		appShell: AppShellStore;
		remoteSettings: RemoteSettingsStore;
	}

	let { appShell, remoteSettings }: SettingsTestHostProps = $props();
	const agentIds = ['claude', 'codex', 'amp', 'cursor', 'factory', 'opencode', 'pi'];
	const agentLabels: Record<string, string> = {
		claude: 'Claude',
		codex: 'Codex',
		amp: 'Amp',
		cursor: 'Cursor',
		factory: 'Factory',
		opencode: 'OpenCode',
		pi: 'Pi',
	};
	type MockAgentMetadata = {
		id: string;
		label: string;
			description: string;
			supportsFork: boolean;
			supportsUpdateProjectPath: boolean;
			supportsImages: boolean;
		acceptsApiProviderEndpoints: boolean;
		supportedProtocols: string[];
		authLoginSupported: boolean;
		defaultModel: string;
	};
	const agentMetadataById: Record<string, MockAgentMetadata> = {
		claude: {
			id: 'claude',
			label: 'Claude',
				description: '',
				supportsFork: true,
				supportsUpdateProjectPath: true,
				supportsImages: true,
			acceptsApiProviderEndpoints: true,
			supportedProtocols: ['anthropic-messages'],
			authLoginSupported: true,
			defaultModel: 'opus',
		},
		codex: {
			id: 'codex',
			label: 'Codex',
				description: '',
				supportsFork: true,
				supportsUpdateProjectPath: true,
				supportsImages: true,
			acceptsApiProviderEndpoints: true,
			supportedProtocols: ['openai-compatible'],
			authLoginSupported: true,
			defaultModel: 'opus',
		},
		amp: {
			id: 'amp',
			label: 'Amp',
				description: '',
				supportsFork: false,
				supportsUpdateProjectPath: false,
				supportsImages: false,
			acceptsApiProviderEndpoints: false,
			supportedProtocols: [],
			authLoginSupported: false,
			defaultModel: 'opus',
		},
		cursor: {
			id: 'cursor',
			label: 'Cursor',
				description: '',
				supportsFork: false,
				supportsUpdateProjectPath: true,
				supportsImages: false,
			acceptsApiProviderEndpoints: false,
			supportedProtocols: [],
			authLoginSupported: false,
			defaultModel: 'opus',
		},
		factory: {
			id: 'factory',
			label: 'Factory',
				description: '',
				supportsFork: false,
				supportsUpdateProjectPath: false,
				supportsImages: false,
			acceptsApiProviderEndpoints: false,
			supportedProtocols: [],
			authLoginSupported: false,
			defaultModel: 'opus',
		},
		opencode: {
			id: 'opencode',
			label: 'OpenCode',
				description: '',
				supportsFork: false,
				supportsUpdateProjectPath: false,
				supportsImages: false,
			acceptsApiProviderEndpoints: false,
			supportedProtocols: [],
			authLoginSupported: false,
			defaultModel: 'opus',
		},
		pi: {
			id: 'pi',
			label: 'Pi',
				description: '',
				supportsFork: true,
				supportsUpdateProjectPath: true,
				supportsImages: false,
			acceptsApiProviderEndpoints: false,
			supportedProtocols: [],
			authLoginSupported: false,
			defaultModel: 'opus',
		},
	};

	setAppShell({
		get showSettings() {
			return appShell.showSettings;
		},
		get settingsTab() {
			return appShell.settingsTab;
		},
		setSettingsTab(tab: string) {
			appShell.setSettingsTab(tab);
		},
		closeSettings() {
			appShell.closeSettings();
		},
	} as never);
	setRemoteSettings({
		get hasSnapshot() {
			return remoteSettings.hasSnapshot;
		},
		get snapshot() {
			return remoteSettings.snapshot;
		},
		get error() {
			return remoteSettings.error;
		},
		refreshInBackground() {
			return remoteSettings.refreshInBackground();
		},
		update(patch: UpdateRemoteSettingsInput) {
			return remoteSettings.update(patch);
		},
	} as never);
	setLocalSettings({
		theme: 'system',
		colorblindMode: false,
		alwaysFullscreenOnGitPanel: true,
		autoExpandTools: false,
		showThinking: true,
		autoScrollToBottom: true,
		sendByShiftEnter: false,
		chatMaxWidth: 'none',
		sidebarGroupByProject: false,
		sidebarCompactChatItems: false,
		set() {},
		toggle() {},
	} as never);
	setModelCatalog({
		version: 0,
		apiProviderCatalog: [],
		getModels() {
			return [{ value: 'opus', label: 'Opus' }];
		},
		getAgent(agentId: string) {
			return agentMetadataById[agentId] ?? null;
		},
		getAgentLabel(agentId: string) {
			return agentLabels[agentId] ?? agentId;
		},
		getAgents() {
			return agentIds;
		},
		getSelectableAgents() {
			return agentIds;
		},
		getAgentMetadataList() {
			return agentIds
				.map((agentId) => agentMetadataById[agentId] ?? null)
				.filter((metadata): metadata is MockAgentMetadata => metadata !== null);
		},
		getDefaultModel() {
			return 'opus';
		},
		getModelForSelection(_provider: string, model: string) {
			return model === 'opus' ? { value: 'opus', label: 'Opus' } : null;
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
		forceRefresh() {
			return Promise.resolve();
		},
		findEndpoint() {
			return null;
		},
	} as never);
</script>

<Settings />
