import { describe, expect, it } from 'vitest';
import { NavigationStore, createNavigationStore } from '../navigation.svelte';

function makeStore(): NavigationStore {
	return new NavigationStore();
}

describe('NavigationStore', () => {
	it('starts on the chat tab', () => {
		const store = makeStore();

		expect(store.activeTab).toBe('chat');
	});

	it('updates the active tab', () => {
		const store = makeStore();

		store.setActiveTab('files');
		expect(store.activeTab).toBe('files');
	});

	it('creates stores through the factory', () => {
		expect(createNavigationStore()).toBeInstanceOf(NavigationStore);
	});
});
