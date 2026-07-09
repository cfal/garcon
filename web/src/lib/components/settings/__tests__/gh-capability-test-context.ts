import type { GhCapabilityContext } from '$lib/stores/gh-capability.svelte';

let ghCapability: GhCapabilityContext | null = null;

export function makeTestGhCapability(
	overrides: Partial<GhCapabilityContext> = {},
): GhCapabilityContext {
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

export function setTestGhCapability(capability: GhCapabilityContext): void {
	ghCapability = capability;
}

export function getTestGhCapability(): GhCapabilityContext {
	if (!ghCapability) return makeTestGhCapability();
	return ghCapability;
}
