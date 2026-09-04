import type { LocalSettingsStore } from '$lib/stores/local-settings.svelte';

let localSettingsStore: LocalSettingsStore | null = null;

export function setTestLocalSettingsStore(store: LocalSettingsStore): void {
	localSettingsStore = store;
}

export function getTestLocalSettingsStore(): LocalSettingsStore {
	if (!localSettingsStore) {
		throw new Error('Local settings test store has not been configured');
	}
	return localSettingsStore;
}
