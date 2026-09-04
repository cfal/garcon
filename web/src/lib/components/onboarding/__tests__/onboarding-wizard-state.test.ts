import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLocalSettingsStore } from '$lib/stores/local-settings.svelte';
import {
	ONBOARDING_PAGE_IDS,
	OnboardingWizardState,
} from '../onboarding-wizard-state.svelte';

function createWizard() {
	const localSettings = createLocalSettingsStore();
	const onClose = vi.fn();
	const onOpenProviders = vi.fn();
	const wizard = new OnboardingWizardState({ localSettings, onClose, onOpenProviders });
	return { localSettings, wizard, onClose, onOpenProviders };
}

describe('OnboardingWizardState', () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it('walks the paged flow in order and clamps at the edges', () => {
		const { wizard } = createWizard();

		expect(wizard.pageId).toBe('theme');
		wizard.back();
		expect(wizard.pageIndex).toBe(0);

		for (const pageId of ONBOARDING_PAGE_IDS.slice(1)) {
			wizard.advance();
			expect(wizard.pageId).toBe(pageId);
		}
		expect(wizard.isDonePage).toBe(true);
		wizard.advance();
		expect(wizard.pageIndex).toBe(ONBOARDING_PAGE_IDS.length - 1);

		wizard.back();
		expect(wizard.pageId).toBe('chat-display');
	});

	it('writes each selection to its local setting', () => {
		const { wizard, localSettings } = createWizard();

		wizard.selectTheme('dark');
		wizard.selectChatItemLayout('single-line');
		wizard.selectChatMaxWidth('medium');

		expect(localSettings.theme).toBe('dark');
		expect(localSettings.sidebarChatItemLayout).toBe('single-line');
		expect(localSettings.chatMaxWidth).toBe('medium');
	});

	it('toggles the chat display switches', () => {
		const { wizard, localSettings } = createWizard();
		const showThinking = localSettings.showThinking;
		const autoExpandTools = localSettings.autoExpandTools;

		wizard.toggleShowThinking();
		wizard.toggleAutoExpandTools();

		expect(localSettings.showThinking).toBe(!showThinking);
		expect(localSettings.autoExpandTools).toBe(!autoExpandTools);
	});

	it('finishes by closing, or closes and opens providers', () => {
		const { wizard, onClose, onOpenProviders } = createWizard();

		wizard.finish();
		expect(onClose).toHaveBeenCalledOnce();
		expect(onOpenProviders).not.toHaveBeenCalled();

		wizard.finishToProviders();
		expect(onClose).toHaveBeenCalledTimes(2);
		expect(onOpenProviders).toHaveBeenCalledOnce();
	});
});
