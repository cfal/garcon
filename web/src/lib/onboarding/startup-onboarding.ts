export type StartupOnboardingDecision = 'wait' | 'ignore' | 'open';

interface StartupOnboardingInput {
	isAuthenticated: boolean;
	isPublicRoute: boolean;
	logoutPending: boolean;
	hadSavedSettingsOnLoad: boolean;
}

export function resolveStartupOnboarding(input: StartupOnboardingInput): StartupOnboardingDecision {
	if (!input.isAuthenticated || input.isPublicRoute || input.logoutPending) return 'wait';
	return input.hadSavedSettingsOnLoad ? 'ignore' : 'open';
}
