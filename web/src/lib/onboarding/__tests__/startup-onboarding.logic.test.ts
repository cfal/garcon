import { beforeEach, describe, expect, it } from 'vitest';
import { StartupOnboardingState } from '../startup-onboarding';

describe('StartupOnboardingState', () => {
	let startup: StartupOnboardingState;
	beforeEach(() => {
		startup = new StartupOnboardingState();
	});

	const ready = {
		isAuthenticated: true,
		isPublicRoute: false,
		logoutPending: false,
		hadSavedSettingsOnLoad: false,
	};

	it.each([{ isAuthenticated: false }, { isPublicRoute: true }, { logoutPending: true }])(
		'waits without consuming setup while the workspace is inaccessible: %j',
		(overrides) => {
			expect(startup.resolve({ ...ready, ...overrides })).toBe('wait');
			expect(startup.resolve(ready)).toBe('open');
		},
	);

	it('opens for a fresh browser after authentication', () => {
		expect(startup.resolve(ready)).toBe('open');
	});

	it('skips setup when this load starts with saved preferences', () => {
		expect(startup.resolve({ ...ready, hadSavedSettingsOnLoad: true })).toBe('ignore');
	});

	it('does not reopen within the same load after authentication is lost and restored', () => {
		expect(startup.resolve({ ...ready, isAuthenticated: false })).toBe('wait');
		expect(startup.resolve(ready)).toBe('open');
		expect(startup.resolve({ ...ready, isAuthenticated: false })).toBe('ignore');
		expect(startup.resolve(ready)).toBe('ignore');
	});

	it('does not reconsider skipped setup when preferences are cleared during the same load', () => {
		expect(startup.resolve({ ...ready, hadSavedSettingsOnLoad: true })).toBe('ignore');
		expect(startup.resolve(ready)).toBe('ignore');
	});

	it('keeps startup decisions independent between loads', () => {
		expect(startup.resolve(ready)).toBe('open');
		expect(new StartupOnboardingState().resolve(ready)).toBe('open');
	});
});
