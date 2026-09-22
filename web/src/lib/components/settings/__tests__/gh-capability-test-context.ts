import type {
	GhCapabilityContext,
	GhNodeCapabilityContext,
} from '$lib/git/pull-requests/gh-capability.svelte';

let ghCapability: GhNodeCapabilityContext | null = null;

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

export function setTestGhCapability(capability: GhNodeCapabilityContext): void {
	ghCapability = capability;
}

export function getTestGhCapability(): GhCapabilityContext {
	const capability = ghCapability ?? makeTestGhCapability();
	return { forNode: () => capability };
}
