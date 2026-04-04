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
		get settingsInitialTab() {
			return appShell.settingsInitialTab;
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
		showChatHeader: false,
		searchBarPosition: 'top',
		set() {},
		toggle() {},
	} as never);
	setModelCatalog({
		version: 0,
		getModels() {
			return [{ value: 'opus', label: 'Opus' }];
		},
		getProviders() {
			return ['claude'];
		},
		refreshIfStale() {
			return Promise.resolve();
		},
	} as never);
</script>

<Settings />
