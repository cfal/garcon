import type { GhNodeCapabilityContext } from '$lib/git/pull-requests/gh-capability.svelte';

export function makeTestGhCapability(
	overrides: Partial<GhNodeCapabilityContext> = {},
): GhNodeCapabilityContext {
	return {
		available: true,
		authenticated: true,
		reason: 'authenticated',
		login: 'octocat',
		host: 'github.com',
		isLoading: false,
		hasChecked: true,
		lastError: null,
		ensureChecked: async () => {},
		refresh: async () => {},
		...overrides,
	};
}
