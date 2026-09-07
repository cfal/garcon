export type FirstRegistrationOnboardingDecision = 'wait' | 'ignore' | 'open';

interface FirstRegistrationOnboardingInput {
	isLoading: boolean;
	isAuthenticated: boolean;
	authDisabled: boolean;
	isRegistrationRoute: boolean;
	justRegistered: boolean;
}

export function resolveFirstRegistrationOnboarding(
	input: FirstRegistrationOnboardingInput,
): FirstRegistrationOnboardingDecision {
	if (input.isLoading || !input.isAuthenticated) return 'wait';
	if (input.authDisabled) return 'ignore';
	if (input.isRegistrationRoute) return 'wait';
	return input.justRegistered ? 'open' : 'ignore';
}
