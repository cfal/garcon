import { describe, it, expect, vi } from 'vitest';
import { AppShellStore, SETTINGS_TABS, isServerSettingsTab } from '../app-shell.svelte';

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

	describe('settings navigation', () => {
		it('normalizes unknown sections and keeps all sections in one dialog', () => {
			const store = new AppShellStore();
			store.openSettings('display');
			expect(store.settingsTab).toBe('interface');
			for (const tab of SETTINGS_TABS) {
				store.openSettings(tab);
				expect(store.showSettings).toBe(true);
				expect(store.settingsTab).toBe(tab);
			}
			store.setSettingsTab('unknown');
			expect(store.settingsTab).toBe('interface');
			store.closeSettings();
			expect(store.showSettings).toBe(false);
		});

		it.each(['preambles', 'scheduled-prompts', 'snippets'] as const)(
			'places %s in server settings and closes onboarding',
			(tab) => {
				const store = new AppShellStore();
				store.openOnboardingWizard();
				store.openSettings(tab);
				expect(store.showOnboardingWizard).toBe(false);
				expect(store.settingsTab).toBe(tab);
				expect(isServerSettingsTab(tab)).toBe(true);
			},
		);

		it('retains the opener across tab changes and restores focus once on close', async () => {
			const store = new AppShellStore();
			const restore = vi.fn();
			store.openSettings('snippets', restore);
			store.setSettingsTab('preambles');
			store.closeSettings();
			expect(restore).not.toHaveBeenCalled();
			await Promise.resolve();
			expect(restore).toHaveBeenCalledOnce();
			store.closeSettings();
			await Promise.resolve();
			expect(restore).toHaveBeenCalledOnce();
		});

		it('drops an old opener when settings are explicitly reopened', async () => {
			const store = new AppShellStore();
			const restore = vi.fn();
			store.openSettings('snippets', restore);
			store.openSettings();
			store.closeSettings();
			await Promise.resolve();
			expect(restore).not.toHaveBeenCalled();
		});

		it('does not restore stale focus over a newly opened dialog', async () => {
			const store = new AppShellStore();
			const restore = vi.fn();
			store.openSettings('preambles', restore);
			store.closeSettings();
			store.openSettings('general');
			await Promise.resolve();
			expect(restore).not.toHaveBeenCalled();
		});

		it('opens onboarding exclusively without restoring focus', async () => {
			const store = new AppShellStore();
			const restore = vi.fn();
			store.openSettings('snippets', restore);
			store.openOnboardingWizard();
			store.closeOnboardingWizard();
			await Promise.resolve();
			expect(store.showSettings).toBe(false);
			expect(store.showOnboardingWizard).toBe(false);
			expect(store.settingsTab).toBe('snippets');
			expect(restore).not.toHaveBeenCalled();
		});
	});

	describe('scheduled prompt catalog visit', () => {
		it.each(['close', 'back', 'tab'] as const)(
			'resumes the scheduled editor through %s without closing settings',
			async (action) => {
				const store = new AppShellStore();
				const restore = vi.fn();
				store.openSettings('scheduled-prompts');
				store.openScheduledPromptPreambles(restore);
				expect(store.scheduledPromptSuspended).toBe(true);
				expect(store.settingsTab).toBe('preambles');
				expect(store.showSettings).toBe(true);
				if (action === 'close') store.closeSettings();
				else if (action === 'back') store.returnToScheduledPrompt();
				else store.setSettingsTab('scheduled-prompts');
				expect(store.scheduledPromptSuspended).toBe(false);
				expect(store.settingsTab).toBe('scheduled-prompts');
				expect(store.showSettings).toBe(true);
				await Promise.resolve();
				expect(restore).toHaveBeenCalledOnce();
				store.closeSettings();
				await Promise.resolve();
				expect(store.showSettings).toBe(false);
				expect(restore).toHaveBeenCalledOnce();
			},
		);

		it('keeps the draft and outer opener while visiting other settings sections', async () => {
			const store = new AppShellStore();
			const outerRestore = vi.fn();
			const pickerRestore = vi.fn();
			store.openSettings('preambles', outerRestore);
			store.setSettingsTab('scheduled-prompts');
			store.openScheduledPromptPreambles(pickerRestore);
			store.setSettingsTab('snippets');
			expect(store.scheduledPromptSuspended).toBe(true);
			store.closeSettings();
			await Promise.resolve();
			expect(store.settingsTab).toBe('scheduled-prompts');
			expect(pickerRestore).toHaveBeenCalledOnce();
			expect(outerRestore).not.toHaveBeenCalled();
			store.closeSettings();
			await Promise.resolve();
			expect(outerRestore).toHaveBeenCalledOnce();
		});

		it.each(['settings', 'onboarding'] as const)(
			'discards the suspended editor when %s is explicitly opened',
			async (destination) => {
				const store = new AppShellStore();
				const restore = vi.fn();
				store.openSettings('scheduled-prompts');
				store.openScheduledPromptPreambles(restore);
				if (destination === 'settings') store.openSettings();
				else store.openOnboardingWizard();
				expect(store.scheduledPromptSuspended).toBe(false);
				store.closeSettings();
				await Promise.resolve();
				expect(restore).not.toHaveBeenCalled();
			},
		);

		it('ignores catalog visits without an active scheduled section', () => {
			const store = new AppShellStore();
			store.openScheduledPromptPreambles(vi.fn());
			expect(store.showSettings).toBe(false);
			expect(store.scheduledPromptSuspended).toBe(false);
			store.openSettings('snippets');
			store.openScheduledPromptPreambles(vi.fn());
			expect(store.settingsTab).toBe('snippets');
			expect(store.scheduledPromptSuspended).toBe(false);
		});
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
