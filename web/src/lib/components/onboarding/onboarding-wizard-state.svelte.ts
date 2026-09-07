// Page flow and option selection for the first-run onboarding wizard.
// Selections write straight to local settings so every page applies live
// behind the dialog. The wizard is remounted on each open, so page state
// does not need an explicit reset.

import type {
	ChatMaxWidth,
	LocalSettingsStore,
	SidebarChatItemLayout,
	ThemeMode,
} from '$lib/stores/local-settings.svelte.js';

export const ONBOARDING_PAGE_IDS = ['theme', 'chat-layout', 'chat-display', 'done'] as const;
export type OnboardingPageId = (typeof ONBOARDING_PAGE_IDS)[number];

interface OnboardingWizardStateDeps {
	localSettings: LocalSettingsStore;
	onClose: () => void;
	onOpenProviders: () => void;
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

	selectTheme(theme: ThemeMode): void {
		this.#deps.localSettings.set('theme', theme);
	}

	selectChatItemLayout(layout: SidebarChatItemLayout): void {
		this.#deps.localSettings.set('sidebarChatItemLayout', layout);
	}

	selectChatMaxWidth(chatMaxWidth: ChatMaxWidth): void {
		this.#deps.localSettings.set('chatMaxWidth', chatMaxWidth);
	}

	toggleShowThinking(): void {
		this.#deps.localSettings.toggle('showThinking');
	}

	toggleAutoExpandTools(): void {
		this.#deps.localSettings.toggle('autoExpandTools');
	}

	finish(): void {
		this.#deps.onClose();
	}

	finishToProviders(): void {
		this.#deps.onClose();
		this.#deps.onOpenProviders();
	}
}
