import { describe, expect, it, vi } from 'vitest';
import { NavigationStore, createNavigationStore } from '../navigation.svelte';

function makeStore(): NavigationStore {
	return new NavigationStore();
}

describe('NavigationStore', () => {
	it('emits chat-adjacent navigation requests', () => {
		const store = makeStore();
		const above = vi.fn();
		const below = vi.fn();

		store.onNavigateChatAboveRequested(above);
		store.onNavigateChatBelowRequested(below);

		store.requestNavigateChatAbove();
		store.requestNavigateChatBelow();

		expect(above).toHaveBeenCalledTimes(1);
		expect(below).toHaveBeenCalledTimes(1);
	});

	it('unsubscribes chat-adjacent navigation request callbacks', () => {
		const store = makeStore();
		const above = vi.fn();
		const unsubscribe = store.onNavigateChatAboveRequested(above);

		store.requestNavigateChatAbove();
		unsubscribe();
		store.requestNavigateChatAbove();

		expect(above).toHaveBeenCalledTimes(1);
	});

	it('creates stores through the factory', () => {
		expect(createNavigationStore()).toBeInstanceOf(NavigationStore);
	});
});
