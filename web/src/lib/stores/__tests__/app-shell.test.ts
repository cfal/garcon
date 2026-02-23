import { describe, it, expect, vi } from 'vitest';
import { AppShellStore } from '../app-shell.svelte';

describe('AppShellStore', () => {
	describe('new chat dialog', () => {
		it('starts with dialog closed', () => {
			const store = new AppShellStore();
			expect(store.newChatDialogOpen).toBe(false);
			expect(store.newChatDialogSeed).toBeNull();
		});

		it('opens dialog with seed and fires callbacks', () => {
			const store = new AppShellStore();
			const cb = vi.fn();
			store.onNewChatDialogSeed(cb);

			store.openNewChatDialog({ prefill: 'hello' });

			expect(store.newChatDialogOpen).toBe(true);
			expect(store.newChatDialogSeed?.prefill).toBe('hello');
			expect(cb).toHaveBeenCalledTimes(1);
		});

		it('opens dialog without seed', () => {
			const store = new AppShellStore();

			store.openNewChatDialog();

			expect(store.newChatDialogOpen).toBe(true);
			expect(store.newChatDialogSeed).toBeNull();
		});

		it('closes dialog', () => {
			const store = new AppShellStore();
			store.openNewChatDialog();

			store.closeNewChatDialog();

			expect(store.newChatDialogOpen).toBe(false);
		});

		it('fires callback on each open', () => {
			const store = new AppShellStore();
			const cb = vi.fn();
			store.onNewChatDialogSeed(cb);

			store.openNewChatDialog();
			store.closeNewChatDialog();
			store.openNewChatDialog({ prefill: 'second' });

			expect(cb).toHaveBeenCalledTimes(2);
			expect(store.newChatDialogSeed?.prefill).toBe('second');
		});

		it('replaces previous seed on re-open', () => {
			const store = new AppShellStore();

			store.openNewChatDialog({ prefill: 'first' });
			expect(store.newChatDialogSeed?.prefill).toBe('first');

			store.openNewChatDialog({ prefill: 'second' });
			expect(store.newChatDialogSeed?.prefill).toBe('second');
		});
	});

	describe('callback registration', () => {
		it('requestNewChat fires registered callbacks', () => {
			const store = new AppShellStore();
			const cb = vi.fn();
			store.onNewChatRequested(cb);

			store.requestNewChat();
			expect(cb).toHaveBeenCalledTimes(1);

			store.requestNewChat();
			expect(cb).toHaveBeenCalledTimes(2);
		});

		it('unsubscribe removes callback', () => {
			const store = new AppShellStore();
			const cb = vi.fn();
			const unsub = store.onNewChatRequested(cb);

			store.requestNewChat();
			expect(cb).toHaveBeenCalledTimes(1);

			unsub();
			store.requestNewChat();
			expect(cb).toHaveBeenCalledTimes(1);
		});

		it('requestSidebarRecenterToSelected fires callbacks', () => {
			const store = new AppShellStore();
			const cb = vi.fn();
			store.onSidebarRecenterRequested(cb);

			store.requestSidebarRecenterToSelected();
			expect(cb).toHaveBeenCalledTimes(1);
		});

		it('requestComposerFocus fires callbacks', () => {
			const store = new AppShellStore();
			const cb = vi.fn();
			store.onComposerFocusRequested(cb);

			store.requestComposerFocus();
			expect(cb).toHaveBeenCalledTimes(1);
		});

		it('requestRenameSelectedChat fires callbacks', () => {
			const store = new AppShellStore();
			const cb = vi.fn();
			store.onRenameSelectedChatRequested(cb);

			store.requestRenameSelectedChat();
			expect(cb).toHaveBeenCalledTimes(1);
		});
	});
});
