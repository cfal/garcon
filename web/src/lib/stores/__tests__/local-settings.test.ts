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
		expect(store.sidebarGroupByProject).toBe(true);
		expect(store.sidebarGroupNestedProjectPaths).toBe(false);
		expect(store.sidebarCompactChatItems).toBe(false);
		expect(store.showQuickCommitTray).toBe(true);

		store.destroy();
	});

	it('persists max chat width', () => {
		const store = createLocalSettingsStore();

		store.set('chatMaxWidth', 'medium');
		store.set('sidebarGroupByProject', false);
		store.set('sidebarGroupNestedProjectPaths', true);
		store.set('sidebarCompactChatItems', true);
		store.set('showQuickCommitTray', false);

		expect(
			JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEYS.localSettings) ?? '{}'),
		).toMatchObject({
			chatMaxWidth: 'medium',
			sidebarGroupByProject: false,
			sidebarGroupNestedProjectPaths: true,
			sidebarCompactChatItems: true,
			showQuickCommitTray: false,
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
				sidebarGroupByProject: true,
				sidebarGroupNestedProjectPaths: true,
				sidebarCompactChatItems: true,
				showQuickCommitTray: false,
			}),
		);
		window.dispatchEvent(
			new StorageEvent('storage', {
				key: LOCAL_STORAGE_KEYS.localSettings,
				newValue: localStorage.getItem(LOCAL_STORAGE_KEYS.localSettings),
			}),
		);

		expect(secondStore.chatMaxWidth).toBe('small');
		expect(secondStore.sidebarGroupByProject).toBe(true);
		expect(secondStore.sidebarGroupNestedProjectPaths).toBe(true);
		expect(secondStore.sidebarCompactChatItems).toBe(true);
		expect(secondStore.showQuickCommitTray).toBe(false);

		firstStore.destroy();
		secondStore.destroy();
	});

	it('falls back to default for invalid nested project grouping setting', () => {
		localStorage.setItem(
			LOCAL_STORAGE_KEYS.localSettings,
			JSON.stringify({
				sidebarGroupNestedProjectPaths: 'yes',
			}),
		);

		const store = createLocalSettingsStore();

		expect(store.sidebarGroupNestedProjectPaths).toBe(false);

		store.destroy();
	});
});
