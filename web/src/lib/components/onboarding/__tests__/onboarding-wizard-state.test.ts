import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLocalSettingsStore } from '$lib/stores/local-settings.svelte';
import { ONBOARDING_PAGE_IDS, OnboardingWizardState } from '../onboarding-wizard-state.svelte';

const localSettingsStores: Array<ReturnType<typeof createLocalSettingsStore>> = [];

function createWizard() {
	const localSettings = createLocalSettingsStore();
	localSettingsStores.push(localSettings);
	const onClose = vi.fn();
	const onOpenProviders = vi.fn();
	const onOpenScheduledPrompts = vi.fn();
	const onOpenPreambles = vi.fn();
	const wizard = new OnboardingWizardState({
		localSettings,
		onClose,
		onOpenProviders,
		onOpenScheduledPrompts,
		onOpenPreambles,
	});
	return {
		localSettings,
		wizard,
		onClose,
		onOpenProviders,
		onOpenScheduledPrompts,
		onOpenPreambles,
	};
}

describe('OnboardingWizardState', () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it.each([
		['finishToProviders', 'onOpenProviders'],
		['finishToScheduledPrompts', 'onOpenScheduledPrompts'],
		['finishToPreambles', 'onOpenPreambles'],
	] as const)('saves and closes before navigating with %s', (action, callback) => {
		const setup = createWizard();
		setup[callback].mockImplementation(() => {
			expect(setup.onClose).toHaveBeenCalledOnce();
			const restored = createLocalSettingsStore();
			expect(restored.hadSavedSettingsOnLoad).toBe(true);
			restored.destroy();
		});
		setup.wizard[action]();
		expect(setup[callback]).toHaveBeenCalledOnce();
	});

	afterEach(() => {
		for (const localSettings of localSettingsStores.splice(0)) {
			localSettings.destroy();
		}
	});

	it('walks the paged flow in order and clamps at the edges', () => {
		const { wizard } = createWizard();

		expect(wizard.pageId).toBe('welcome');
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
		expect(wizard.pageId).toBe('transcript-search');
	});

	it('finishes by closing, or closes and opens providers', () => {
		const { wizard, localSettings, onClose, onOpenProviders } = createWizard();

		wizard.finish();
		expect(localSettings.hadSavedSettingsOnLoad).toBe(false);
		const restored = createLocalSettingsStore();
		expect(restored.hadSavedSettingsOnLoad).toBe(true);
		restored.destroy();
		expect(onClose).toHaveBeenCalledOnce();
		expect(onOpenProviders).not.toHaveBeenCalled();

		wizard.finishToProviders();
		expect(onClose).toHaveBeenCalledTimes(2);
		expect(onOpenProviders).toHaveBeenCalledOnce();
	});
});
