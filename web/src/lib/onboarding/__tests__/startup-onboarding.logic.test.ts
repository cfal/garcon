import { describe, expect, it } from 'vitest';
import { resolveStartupOnboarding } from '../startup-onboarding';

describe('resolveStartupOnboarding', () => {
	const ready = {
		isAuthenticated: true,
		isPublicRoute: false,
		logoutPending: false,
		hadSavedSettingsOnLoad: false,
	};

	it.each([{ isAuthenticated: false }, { isPublicRoute: true }, { logoutPending: true }])(
		'waits without consuming setup while the workspace is inaccessible: %j',
		(overrides) => {
			expect(resolveStartupOnboarding({ ...ready, ...overrides })).toBe('wait');
		},
	);

	it('opens for a fresh browser after authentication', () => {
		expect(resolveStartupOnboarding(ready)).toBe('open');
	});

	it('does not reopen for existing preferences or after dismissal', () => {
		expect(resolveStartupOnboarding({ ...ready, hadSavedSettingsOnLoad: true })).toBe('ignore');
	});
});
