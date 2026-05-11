import { beforeEach, describe, expect, it } from 'vitest';
import { createLocalSettingsStore } from '../local-settings.svelte';

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

		expect(JSON.parse(localStorage.getItem('pref_local_settings') ?? '{}')).toMatchObject({
			chatMaxWidth: 'medium',
		});

		store.destroy();
	});

	it('syncs max chat width across storage events', () => {
		const firstStore = createLocalSettingsStore();
		const secondStore = createLocalSettingsStore();

		localStorage.setItem('pref_local_settings', JSON.stringify({
			...firstStore.snapshot(),
			chatMaxWidth: 'small',
		}));
		window.dispatchEvent(new StorageEvent('storage', {
			key: 'pref_local_settings',
			newValue: localStorage.getItem('pref_local_settings'),
		}));

		expect(secondStore.chatMaxWidth).toBe('small');

		firstStore.destroy();
		secondStore.destroy();
	});
});
