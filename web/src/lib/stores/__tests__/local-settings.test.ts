import { beforeEach, describe, expect, it } from 'vitest';
import { createLocalSettingsStore } from '../local-settings.svelte';

describe('LocalSettingsStore', () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it('defaults sidebar controls position to top', () => {
		const store = createLocalSettingsStore();

		expect(store.searchBarPosition).toBe('top');

		store.destroy();
	});

	it('defaults chat horizontal margins to disabled', () => {
		const store = createLocalSettingsStore();

		expect(store.chatHorizontalMargins).toBe(false);

		store.destroy();
	});

	it('persists sidebar controls position', () => {
		const store = createLocalSettingsStore();

		store.set('searchBarPosition', 'top');

		expect(JSON.parse(localStorage.getItem('pref_local_settings') ?? '{}')).toMatchObject({
			searchBarPosition: 'top',
		});

		store.destroy();
	});

	it('persists chat horizontal margins', () => {
		const store = createLocalSettingsStore();

		store.set('chatHorizontalMargins', true);

		expect(JSON.parse(localStorage.getItem('pref_local_settings') ?? '{}')).toMatchObject({
			chatHorizontalMargins: true,
		});

		store.destroy();
	});

	it('syncs sidebar controls position across storage events', () => {
		const firstStore = createLocalSettingsStore();
		const secondStore = createLocalSettingsStore();

		localStorage.setItem('pref_local_settings', JSON.stringify({
			...firstStore.snapshot(),
			searchBarPosition: 'top',
		}));
		window.dispatchEvent(new StorageEvent('storage', {
			key: 'pref_local_settings',
			newValue: localStorage.getItem('pref_local_settings'),
		}));

		expect(secondStore.searchBarPosition).toBe('top');

		firstStore.destroy();
		secondStore.destroy();
	});

	it('syncs chat horizontal margins across storage events', () => {
		const firstStore = createLocalSettingsStore();
		const secondStore = createLocalSettingsStore();

		localStorage.setItem('pref_local_settings', JSON.stringify({
			...firstStore.snapshot(),
			chatHorizontalMargins: true,
		}));
		window.dispatchEvent(new StorageEvent('storage', {
			key: 'pref_local_settings',
			newValue: localStorage.getItem('pref_local_settings'),
		}));

		expect(secondStore.chatHorizontalMargins).toBe(true);

		firstStore.destroy();
		secondStore.destroy();
	});
});
