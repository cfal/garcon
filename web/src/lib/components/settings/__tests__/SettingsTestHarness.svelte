<script lang="ts">
	import Settings from '../Settings.svelte';
	import { setAppShell, setLocalSettings, setModelCatalog, setRemoteSettings } from '$lib/context';
	import type { AppShellStore } from '$lib/stores/app-shell.svelte';
	import type { RemoteSettingsStore } from '$lib/stores/remote-settings.svelte';
	import type { UpdateRemoteSettingsInput } from '$shared/settings';

	interface SettingsTestHarnessProps {
		appShell: AppShellStore;
		remoteSettings: RemoteSettingsStore;
	}

	let { appShell, remoteSettings }: SettingsTestHarnessProps = $props();

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
		set() {},
		toggle() {},
	} as never);
	setModelCatalog({
		version: 0,
		apiProviderCatalog: [],
			getModels() {
				return [{ value: 'opus', label: 'Opus' }];
			},
			getHarness() {
				return {
					id: 'claude',
					label: 'Claude',
					description: '',
					supportsFork: true,
					supportsImages: true,
					acceptsApiProviderEndpoints: true,
					supportedProtocols: ['anthropic-messages'],
					defaultModel: 'opus',
				};
			},
			getHarnessLabel() {
				return 'Claude';
			},
				getHarnesses() {
					return ['claude'];
				},
				getSelectableHarnesses() {
					return ['claude'];
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
