import { describe, it, expect } from 'vitest';
import { ChatLifecycleStore, type LoadingStatusEntry } from '../chat-lifecycle.svelte';

function makeStore(): ChatLifecycleStore {
	return new ChatLifecycleStore();
}

function makeEntry(id: string, text = 'Running', tokens = 0): LoadingStatusEntry {
	return { id, text, tokens, can_interrupt: false };
}

describe('ChatLifecycleStore', () => {
	describe('initial state', () => {
		it('starts idle with no selected-turn metadata', () => {
			const store = makeStore();
			expect(store.turnStatus).toBe('idle');
			expect(store.loadingStatus).toBeNull();
			expect(store.currentChatId).toBeNull();
		});
	});

	describe('turn status transitions', () => {
		it('setTurnStatus changes the turn status', () => {
			const store = makeStore();
			store.setTurnStatus('running');
			expect(store.turnStatus).toBe('running');

			store.setTurnStatus('waiting-permission');
			expect(store.turnStatus).toBe('waiting-permission');
		});

		it('markTurnRunning records running metadata for a chat', () => {
			const store = makeStore();
			store.markTurnRunning('chat-1');

			expect(store.turnStatus).toBe('running');
			expect(store.currentChatId).toBe('chat-1');
		});

		it('beginTurn sets running lifecycle metadata for a chat', () => {
			const store = makeStore();
			store.beginTurn('chat-1');

			expect(store.turnStatus).toBe('running');
			expect(store.currentChatId).toBe('chat-1');
			expect(store.loadingStatus).toMatchObject({
				text: 'Processing',
				tokens: 0,
				can_interrupt: true,
			});
		});

		it('clearTurnStatus resets selected-turn metadata to idle', () => {
			const store = makeStore();
			store.markTurnRunning('chat-1');
			store.pushLoadingStatus(makeEntry('e1'));

			store.clearTurnStatus();

			expect(store.turnStatus).toBe('idle');
			expect(store.loadingStatusStack).toEqual([]);
		});
	});

	describe('loading status stack', () => {
		it('setLoadingStatus replaces stack with single entry', () => {
			const store = makeStore();
			store.pushLoadingStatus(makeEntry('e1'));
			store.pushLoadingStatus(makeEntry('e2'));

			store.setLoadingStatus({ text: 'New', tokens: 10, can_interrupt: true });

			expect(store.loadingStatusStack).toHaveLength(1);
			expect(store.loadingStatus?.text).toBe('New');
			expect(store.loadingStatus?.tokens).toBe(10);
		});

		it('setLoadingStatus(null) clears the stack', () => {
			const store = makeStore();
			store.pushLoadingStatus(makeEntry('e1'));
			store.setLoadingStatus(null);
			expect(store.loadingStatusStack).toEqual([]);
			expect(store.loadingStatus).toBeNull();
		});

		it('pushLoadingStatus appends entries', () => {
			const store = makeStore();
			store.pushLoadingStatus(makeEntry('e1', 'First'));
			store.pushLoadingStatus(makeEntry('e2', 'Second'));

			expect(store.loadingStatusStack).toHaveLength(2);
			expect(store.loadingStatus?.text).toBe('Second');
		});

		it('popLoadingStatus removes last entry with matching id', () => {
			const store = makeStore();
			store.pushLoadingStatus(makeEntry('perm-1', 'A'));
			store.pushLoadingStatus(makeEntry('perm-2', 'B'));
			store.pushLoadingStatus(makeEntry('perm-1', 'C'));

			store.popLoadingStatus('perm-1');

			// Should remove the last 'perm-1' entry (C), leaving A and B.
			expect(store.loadingStatusStack).toHaveLength(2);
			expect(store.loadingStatusStack[0].text).toBe('A');
			expect(store.loadingStatusStack[1].text).toBe('B');
		});

		it('popLoadingStatus is a no-op for unknown id', () => {
			const store = makeStore();
			store.pushLoadingStatus(makeEntry('e1'));
			store.popLoadingStatus('unknown');
			expect(store.loadingStatusStack).toHaveLength(1);
		});
	});

	describe('chat id and system change', () => {
		it('setCurrentChatId updates the id', () => {
			const store = makeStore();
			store.setCurrentChatId('chat-1');
			expect(store.currentChatId).toBe('chat-1');

			store.setCurrentChatId(null);
			expect(store.currentChatId).toBeNull();
		});

		it('setIsSystemChatChange toggles the flag', () => {
			const store = makeStore();
			store.setIsSystemChatChange(true);
			expect(store.isSystemChatChange).toBe(true);

			store.setIsSystemChatChange(false);
			expect(store.isSystemChatChange).toBe(false);
		});
	});
});
