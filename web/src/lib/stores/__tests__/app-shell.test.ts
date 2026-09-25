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

		it('requestComposerFocus increments the reactive request counter', () => {
			const store = new AppShellStore();

			expect(store.composerFocusRequestId).toBe(0);
			store.requestComposerFocus();
			expect(store.composerFocusRequestId).toBe(1);

			store.requestComposerFocus();
			expect(store.composerFocusRequestId).toBe(2);
		});

		it('requestRenameSelectedChat fires callbacks', () => {
			const store = new AppShellStore();
			const cb = vi.fn();
			store.onRenameSelectedChatRequested(cb);

			store.requestRenameSelectedChat();
			expect(cb).toHaveBeenCalledTimes(1);
		});

		it('requestDeleteSelectedChat fires callbacks', () => {
			const store = new AppShellStore();
			const cb = vi.fn();
			store.onDeleteSelectedChatRequested(cb);

			store.requestDeleteSelectedChat();
			expect(cb).toHaveBeenCalledTimes(1);
		});

		it('requestDeleteSelectedChat unsubscribe removes callback', () => {
			const store = new AppShellStore();
			const cb = vi.fn();
			const unsub = store.onDeleteSelectedChatRequested(cb);

			store.requestDeleteSelectedChat();
			expect(cb).toHaveBeenCalledTimes(1);

			unsub();
			store.requestDeleteSelectedChat();
			expect(cb).toHaveBeenCalledTimes(1);
		});
	});

	describe('settings tabs', () => {
		it('defaults unknown server sections to executors', () => {
			const store = new AppShellStore();

			store.openSettings('display');
			expect(store.settingsTab).toBe('executors');

			store.openSettings('general');
			expect(store.settingsTab).toBe('general');

			store.setSettingsTab('other-agents');
			expect(store.settingsTab).toBe('other-agents');
		});

		it('keeps app and server settings mutually exclusive with independent tabs', () => {
			const store = new AppShellStore();
			store.openSettings('github');
			store.openAppSettings('shortcuts');
			expect(store.showSettings).toBe(false);
			expect(store.showAppSettings).toBe(true);
			expect(store.settingsTab).toBe('github');
			expect(store.appSettingsTab).toBe('shortcuts');
			store.openSettings();
			expect(store.showAppSettings).toBe(false);
			expect(store.showSettings).toBe(true);
			expect(store.settingsTab).toBe('executors');
			store.openAppSettings('unknown');
			expect(store.appSettingsTab).toBe('general');
			store.closeAppSettings();
			expect(store.showAppSettings).toBe(false);
		});

		it.each(['openScheduledPrompts', 'openOnboardingWizard', 'openPreambles', 'openSnippets'] as const)(
			'%s closes app settings', (open) => {
				const store = new AppShellStore();
				store.openAppSettings();
				store[open]();
				expect(store.showAppSettings).toBe(false);
				store.openAppSettings();
				expect(store.showScheduledPrompts).toBe(false);
				expect(store.showOnboardingWizard).toBe(false);
				expect(store.showPreambles).toBe(false);
				expect(store.showSnippets).toBe(false);
			},
		);
	});

	describe('scheduled prompts dialog', () => {
		it('opens independently and closes settings', () => {
			const store = new AppShellStore();
			store.openSettings('general');

			store.openScheduledPrompts();

			expect(store.showScheduledPrompts).toBe(true);
			expect(store.showSettings).toBe(false);

			store.openSettings();
			expect(store.showScheduledPrompts).toBe(false);
			expect(store.showSettings).toBe(true);
		});

		it('closes without changing settings tab state', () => {
			const store = new AppShellStore();
			store.setSettingsTab('general');
			store.openScheduledPrompts();

			store.closeScheduledPrompts();

			expect(store.showScheduledPrompts).toBe(false);
			expect(store.settingsTab).toBe('general');
		});
	});

	describe('snippets dialog', () => {
		it('opens exclusively and returns focus after a user close', async () => {
			const store = new AppShellStore();
			const returnFocus = vi.fn();
			store.openSettings('general');

			store.openSnippets(returnFocus);

			expect(store.showSnippets).toBe(true);
			expect(store.showSettings).toBe(false);
			expect(store.showScheduledPrompts).toBe(false);

			store.closeSnippets();
			expect(store.showSnippets).toBe(false);
			expect(returnFocus).not.toHaveBeenCalled();
			await Promise.resolve();
			expect(returnFocus).toHaveBeenCalledTimes(1);
		});

		it('dismisses without restoring focus when another shell dialog opens', async () => {
			const store = new AppShellStore();
			const returnFocus = vi.fn();
			store.openSnippets(returnFocus);

			store.openScheduledPrompts();
			await Promise.resolve();

			expect(store.showSnippets).toBe(false);
			expect(store.showScheduledPrompts).toBe(true);
			expect(returnFocus).not.toHaveBeenCalled();
		});
	});

	describe('onboarding wizard dialog', () => {
		it('opens exclusively and closes other shell dialogs', async () => {
			const store = new AppShellStore();
			const returnFocus = vi.fn();
			store.openSettings('general');
			store.openSnippets(returnFocus);

			store.openOnboardingWizard();
			await Promise.resolve();

			expect(store.showOnboardingWizard).toBe(true);
			expect(store.showSettings).toBe(false);
			expect(store.showScheduledPrompts).toBe(false);
			expect(store.showSnippets).toBe(false);
			expect(returnFocus).not.toHaveBeenCalled();
		});

		it('closes when settings open', () => {
			const store = new AppShellStore();
			store.openOnboardingWizard();

			store.openAppSettings();

			expect(store.showOnboardingWizard).toBe(false);
			expect(store.showAppSettings).toBe(true);
		});

		it('closes when scheduled prompts or snippets open', () => {
			const store = new AppShellStore();
			store.openOnboardingWizard();

			store.openScheduledPrompts();

			expect(store.showOnboardingWizard).toBe(false);
			expect(store.showScheduledPrompts).toBe(true);

			store.openOnboardingWizard();
			store.openSnippets();

			expect(store.showOnboardingWizard).toBe(false);
			expect(store.showSnippets).toBe(true);
		});

		it('closes without touching settings tab state', () => {
			const store = new AppShellStore();
			store.setSettingsTab('general');
			store.openOnboardingWizard();

			store.closeOnboardingWizard();

			expect(store.showOnboardingWizard).toBe(false);
			expect(store.settingsTab).toBe('general');
		});
	});

	describe('preambles dialog', () => {
		it('opens exclusively with the other shell dialogs', () => {
			const store = new AppShellStore();
			store.openSettings('general');

			store.openPreambles();

			expect(store.showPreambles).toBe(true);
			expect(store.showOnboardingWizard).toBe(false);
			expect(store.showSettings).toBe(false);
			expect(store.showScheduledPrompts).toBe(false);
			expect(store.showSnippets).toBe(false);

			store.openSnippets();
			expect(store.showPreambles).toBe(false);
			expect(store.showSnippets).toBe(true);

			store.openOnboardingWizard();
			store.openPreambles();
			expect(store.showOnboardingWizard).toBe(false);
			expect(store.showPreambles).toBe(true);

			store.openScheduledPrompts();
			expect(store.showPreambles).toBe(false);
			expect(store.showScheduledPrompts).toBe(true);
		});

		it('closes without changing settings tab state', () => {
			const store = new AppShellStore();
			store.setSettingsTab('general');
			store.openPreambles();

			store.closePreambles();

			expect(store.showPreambles).toBe(false);
			expect(store.settingsTab).toBe('general');
		});

		it('restores the captured opener after catalog management closes', async () => {
			const store = new AppShellStore();
			const restore = vi.fn();
			store.openPreambles(restore);

			store.closePreambles();
			await Promise.resolve();

			expect(restore).toHaveBeenCalledOnce();
		});

		it('keeps the scheduled editor mounted during nested catalog management', async () => {
			const store = new AppShellStore();
			const restore = vi.fn();
			store.openScheduledPrompts();

			store.openPreamblesOverScheduledPrompts(restore);

			expect(store.showScheduledPrompts).toBe(true);
			expect(store.showPreambles).toBe(true);
			store.closePreambles();
			await Promise.resolve();
			expect(store.showScheduledPrompts).toBe(true);
			expect(restore).toHaveBeenCalledOnce();
		});

		it('captures both chat and transcript view for selection editing', () => {
			const store = new AppShellStore();
			store.openChatPreambleSelection('1783725900000200', '12345678-1234-4123-8123-123456789abc');
			expect(store.chatPreambleSelectionTarget).toEqual({
				chatId: '1783725900000200',
				transcriptViewId: '12345678-1234-4123-8123-123456789abc',
			});
		});
	});
});
