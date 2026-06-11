import { describe, expect, it } from 'vitest';
import { NavigationStore, createNavigationStore } from '../navigation.svelte';

function makeStore(): NavigationStore {
	return new NavigationStore();
}

describe('NavigationStore', () => {
	it('starts on the chat tab with no pending rename request', () => {
		const store = makeStore();

		expect(store.activeTab).toBe('chat');
		expect(store.isInputFocused).toBe(false);
		expect(store.pendingRenameRequest).toBeNull();
	});

	it('updates the active tab', () => {
		const store = makeStore();

		store.setActiveTab('files');
		expect(store.activeTab).toBe('files');
	});

	it('tracks input focus state', () => {
		const store = makeStore();

		store.setIsInputFocused(true);
		expect(store.isInputFocused).toBe(true);

		store.setIsInputFocused(false);
		expect(store.isInputFocused).toBe(false);
	});

	it('stores and clears pending rename requests', () => {
		const store = makeStore();
		const request = { chatId: 'chat-1', currentName: 'Old title' };

		store.requestRename(request);
		expect(store.pendingRenameRequest).toEqual(request);

		store.clearPendingRenameRequest();
		expect(store.pendingRenameRequest).toBeNull();
	});

	it('creates stores through the factory', () => {
		expect(createNavigationStore()).toBeInstanceOf(NavigationStore);
	});
});
