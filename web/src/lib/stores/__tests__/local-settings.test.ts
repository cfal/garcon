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
		expect(store.sidebarCompactChatItems).toBe(false);
		expect(store.showQuickCommitTray).toBe(true);

		store.destroy();
	});

	it('persists max chat width', () => {
		const store = createLocalSettingsStore();

		store.set('chatMaxWidth', 'medium');
		store.set('sidebarGroupByProject', false);
		store.set('sidebarCompactChatItems', true);
		store.set('showQuickCommitTray', false);

		expect(JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEYS.localSettings) ?? '{}')).toMatchObject({
			chatMaxWidth: 'medium',
			sidebarGroupByProject: false,
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
		expect(secondStore.sidebarCompactChatItems).toBe(true);
		expect(secondStore.showQuickCommitTray).toBe(false);

		firstStore.destroy();
		secondStore.destroy();
	});
});
