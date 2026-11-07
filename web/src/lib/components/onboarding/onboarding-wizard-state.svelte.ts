// Remounting the wizard on each open resets its page flow.

import type { LocalSettingsStore } from '$lib/stores/local-settings.svelte.js';

export const ONBOARDING_PAGE_IDS = [
	'theme',
	'chat-layout',
	'chat-display',
	'writing',
	'done',
] as const;
export type OnboardingPageId = (typeof ONBOARDING_PAGE_IDS)[number];

interface OnboardingWizardStateDeps {
	localSettings: LocalSettingsStore;
	onClose: () => void;
	onOpenProviders: () => void;
	onOpenScheduledPrompts: () => void;
	onOpenPreambles: () => void;
}

export class OnboardingWizardState {
	#deps: OnboardingWizardStateDeps;
	pageIndex = $state(0);

	constructor(deps: OnboardingWizardStateDeps) {
		this.#deps = deps;
	}

	get pageId(): OnboardingPageId {
		return ONBOARDING_PAGE_IDS[this.pageIndex];
	}

	get pageCount(): number {
		return ONBOARDING_PAGE_IDS.length;
	}

	get isFirstPage(): boolean {
		return this.pageIndex === 0;
	}

	get isDonePage(): boolean {
		return this.pageId === 'done';
	}

	advance(): void {
		if (this.pageIndex < ONBOARDING_PAGE_IDS.length - 1) this.pageIndex += 1;
	}

	back(): void {
		if (this.pageIndex > 0) this.pageIndex -= 1;
	}

	finish(): void {
		this.#deps.localSettings.save();
		this.#deps.onClose();
	}

	finishToProviders(): void {
		this.finish();
		this.#deps.onOpenProviders();
	}

	finishToScheduledPrompts(): void {
		this.finish();
		this.#deps.onOpenScheduledPrompts();
	}

	finishToPreambles(): void {
		this.finish();
		this.#deps.onOpenPreambles();
	}
}
