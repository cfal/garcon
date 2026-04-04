import type { RemoteSettingsStore } from '$lib/stores/remote-settings.svelte';

let remoteSettingsStore: RemoteSettingsStore | null = null;

export function setTestRemoteSettingsStore(store: RemoteSettingsStore): void {
	remoteSettingsStore = store;
}

export function getTestRemoteSettingsStore(): RemoteSettingsStore {
	if (!remoteSettingsStore) {
		throw new Error('Remote settings test store has not been configured');
	}
	return remoteSettingsStore;
}
