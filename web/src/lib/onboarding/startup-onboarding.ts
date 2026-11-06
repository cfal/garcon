export type StartupOnboardingDecision = 'wait' | 'ignore' | 'open';

interface StartupOnboardingInput {
	isAuthenticated: boolean;
	isPublicRoute: boolean;
	logoutPending: boolean;
	hadSavedSettingsOnLoad: boolean;
}

export class StartupOnboardingState {
	#resolved = false;

	resolve(input: StartupOnboardingInput): StartupOnboardingDecision {
		if (this.#resolved) return 'ignore';
		if (!input.isAuthenticated || input.isPublicRoute || input.logoutPending) return 'wait';
		this.#resolved = true;
		return input.hadSavedSettingsOnLoad ? 'ignore' : 'open';
	}
}
