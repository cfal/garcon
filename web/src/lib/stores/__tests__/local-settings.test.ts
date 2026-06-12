import { beforeEach, describe, expect, it } from 'vitest';
import { createLocalSettingsStore } from '../local-settings.svelte';
import { LOCAL_STORAGE_KEYS } from '$lib/utils/local-persistence';

describe('LocalSettingsStore', () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it('defaults max chat width to none', () => {
		const store = createLocalSettingsStore();

		expect(store.chatMaxWidth).toBe('none');

		store.destroy();
	});

	it('persists max chat width', () => {
		const store = createLocalSettingsStore();

		store.set('chatMaxWidth', 'medium');

		expect(JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEYS.localSettings) ?? '{}')).toMatchObject({
			chatMaxWidth: 'medium',
		});

		store.destroy();
	});

	it('syncs max chat width across storage events', () => {
		const firstStore = createLocalSettingsStore();
		const secondStore = createLocalSettingsStore();

		localStorage.setItem(
			LOCAL_STORAGE_KEYS.localSettings,
			JSON.stringify({
				...firstStore.snapshot(),
				chatMaxWidth: 'small',
			}),
		);
		window.dispatchEvent(
			new StorageEvent('storage', {
				key: LOCAL_STORAGE_KEYS.localSettings,
				newValue: localStorage.getItem(LOCAL_STORAGE_KEYS.localSettings),
			}),
		);

		expect(secondStore.chatMaxWidth).toBe('small');

		firstStore.destroy();
		secondStore.destroy();
	});
});
