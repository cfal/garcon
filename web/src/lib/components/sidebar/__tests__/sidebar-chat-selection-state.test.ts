import { describe, expect, it } from 'vitest';
import { SidebarChatSelectionState } from '../sidebar-chat-selection-state.svelte.js';

function makeStore(): SidebarChatSelectionState {
	return new SidebarChatSelectionState();
}

function selectedIds(store: SidebarChatSelectionState): string[] {
	return [...store.selectedIds];
}

describe('SidebarChatSelectionState', () => {
	it('starts inactive with no selection', () => {
		const store = makeStore();

		expect(store.isActive).toBe(false);
		expect(store.count).toBe(0);
		expect(store.lastClickedId).toBeNull();
		expect(store.isSelected('chat-1')).toBe(false);
	});

	it('enters and exits multi-select mode with an optional initial chat', () => {
		const store = makeStore();

		store.enter('chat-1');

		expect(store.isActive).toBe(true);
		expect(selectedIds(store)).toEqual(['chat-1']);
		expect(store.lastClickedId).toBe('chat-1');

		store.exit();

		expect(store.isActive).toBe(false);
		expect(selectedIds(store)).toEqual([]);
		expect(store.lastClickedId).toBeNull();
	});

	it('toggles selection and clears the range anchor when the selection becomes empty', () => {
		const store = makeStore();

		store.toggle('chat-1');
		expect(selectedIds(store)).toEqual(['chat-1']);
		expect(store.lastClickedId).toBe('chat-1');

		store.toggle('chat-2');
		expect(selectedIds(store)).toEqual(['chat-1', 'chat-2']);
		expect(store.lastClickedId).toBe('chat-2');

		store.toggle('chat-1');
		expect(selectedIds(store)).toEqual(['chat-2']);
		expect(store.lastClickedId).toBe('chat-1');

		store.toggle('chat-2');
		expect(selectedIds(store)).toEqual([]);
		expect(store.lastClickedId).toBeNull();
	});

	it('selects additive ranges from the last clicked chat', () => {
		const store = makeStore();
		store.toggle('b');

		store.selectRange(['a', 'b', 'c', 'd'], 'd');

		expect(selectedIds(store)).toEqual(['b', 'c', 'd']);
		expect(store.lastClickedId).toBe('b');
	});

	it('falls back to toggling when range anchors are unavailable', () => {
		const store = makeStore();

		store.selectRange(['a', 'b'], 'b');
		expect(selectedIds(store)).toEqual(['b']);
		expect(store.lastClickedId).toBe('b');

		store.selectRange(['a', 'c'], 'c');
		expect(selectedIds(store)).toEqual(['b', 'c']);
		expect(store.lastClickedId).toBe('c');
	});

	it('selects and deselects all visible ids', () => {
		const store = makeStore();

		store.selectAll(['a', 'b', 'c']);
		expect(selectedIds(store)).toEqual(['a', 'b', 'c']);
		expect(store.count).toBe(3);

		store.deselectAll();
		expect(selectedIds(store)).toEqual([]);
		expect(store.count).toBe(0);
		expect(store.lastClickedId).toBeNull();
	});

	it('prunes selected ids that are no longer visible', () => {
		const store = makeStore();
		store.selectAll(['a', 'b', 'c']);

		store.pruneToVisible(new Set(['b', 'c', 'd']));

		expect(selectedIds(store)).toEqual(['b', 'c']);
	});
});
